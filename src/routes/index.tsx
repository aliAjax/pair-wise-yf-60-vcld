import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';

type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
type Role = 'auditor' | 'developer' | 'retester';

interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  groupId: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
}
interface AuditEvent { id: string; at: string; issueId: string; message: string }
interface WorkbenchState { version: 2; issues: AuditIssue[]; events: AuditEvent[] }

const STATUS_LABEL: Record<IssueStatus, string> = { open: '待分诊', triaged: '已确认', fixing: '修复中', verifying: '待复测', closed: '已关闭', reopened: '重新打开' };
const SEVERITY_LABEL: Record<Severity, string> = { critical: '阻断', serious: '严重', moderate: '中等', minor: '轻微' };
const SEVERITY_RANK: Record<Severity, number> = { minor: 0, moderate: 1, serious: 2, critical: 3 };
// 状态推进顺序：待复测及以后的状态在组内重算、合并或升档时不允许倒退
const STATUS_RANK: Record<IssueStatus, number> = { open: 0, triaged: 1, fixing: 2, reopened: 2, verifying: 3, closed: 4 };
const ROLE_LABEL: Record<Role, string> = { auditor: '审核员', developer: '开发人员', retester: '复测人员' };
const ROLE_ORDER: Role[] = ['auditor', 'developer', 'retester'];

type TransitionKey = 'confirm' | 'startFix' | 'submitFix' | 'pass' | 'fail';
interface TransitionDef {
  role: Role;
  from: IssueStatus[];
  to: IssueStatus;
  label: string;
  event: string;
  patch?: Partial<Pick<AuditIssue, 'fixNote' | 'retestNote'>>;
}
// 审核员确认，开发人员推进已确认的问题，复测人员关闭或重新打开
const TRANSITIONS: Record<TransitionKey, TransitionDef> = {
  confirm: { role: 'auditor', from: ['open'], to: 'triaged', label: '确认问题', event: '审核员确认问题有效' },
  startFix: { role: 'developer', from: ['triaged', 'reopened'], to: 'fixing', label: '开始修复', event: '开发人员开始修复', patch: { fixNote: '修复进行中，等待提交复测版本' } },
  submitFix: { role: 'developer', from: ['fixing'], to: 'verifying', label: '提交复测', event: '开发人员提交修复，进入待复测' },
  pass: { role: 'retester', from: ['verifying'], to: 'closed', label: '复测通过', event: '复测通过，问题关闭', patch: { retestNote: '键盘、读屏和错误提示均已通过' } },
  fail: { role: 'retester', from: ['verifying', 'closed'], to: 'reopened', label: '重新打开', event: '复测未通过，问题重新打开', patch: { retestNote: '复测未通过：焦点顺序仍不正确' } }
};

const seed: WorkbenchState = {
  version: 2,
  issues: [
    { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', groupId: 'issue-1', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
    { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', groupId: 'issue-2', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString() },
    { id: 'issue-3', title: '结算弹窗 Esc 后焦点回到页面顶部', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 观察焦点是否回到触发按钮', impactGroup: '键盘用户', severity: 'critical', status: 'triaged', canonicalId: 'issue-1', groupId: 'issue-1', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3500_000).toISOString() }
  ],
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效，主问题进入「已确认」' },
    { id: 'e-2', at: new Date(Date.now() - 3550_000).toISOString(), issueId: 'issue-1', message: '审核员将《结算弹窗 Esc 后焦点回到页面顶部》并入主问题《结算弹窗关闭后焦点丢失》（移动 1 条记录，原复现步骤与影响人群各自保留），组内出现更高严重程度，整组按最高档「阻断」处理' },
    { id: 'e-3', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员开始修复，主问题进入「修复中」' }
  ]
};

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

const STORAGE_KEY = 'a11y-audit-v2';
const LEGACY_KEY = 'a11y-audit-v1';

type StoredIssue = Omit<AuditIssue, 'groupId'> & { groupId?: string };
interface StoredState { version?: number; issues?: StoredIssue[]; events?: AuditEvent[] }

// 旧数据升级：只补齐组标识，原有字段、状态和时间保持不变，不重写原有记录
function migrateLegacy(raw: StoredState): WorkbenchState {
  const issues = (raw.issues ?? []).map((issue) => ({ ...issue })) as AuditIssue[];
  for (const issue of issues) if (!issue.canonicalId && !issue.groupId) issue.groupId = issue.id;
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  for (const issue of issues) {
    if (issue.groupId) continue;
    const canonical = issue.canonicalId ? byId.get(issue.canonicalId) : undefined;
    issue.groupId = canonical?.groupId ?? issue.id;
  }
  return { version: 2, issues, events: raw.events ?? [] };
}

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
    return raw ? migrateLegacy(JSON.parse(raw) as StoredState) : seed;
  } catch { return seed; }
}

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [role, setRole] = createSignal<Role>('auditor');
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [actionError, setActionError] = createSignal('');
  const [formError, setFormError] = createSignal('');
  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  // 统计只按主问题计一次：重复问题不进入任何统计口径
  const canonicals = createMemo(() => state.issues.filter((issue) => !issue.canonicalId));
  const duplicateCount = createMemo(() => state.issues.length - canonicals().length);
  const groupMembers = (groupId: string) => state.issues.filter((issue) => issue.groupId === groupId);
  // 组内出现更高严重程度时，整组按最高档走
  const groupSeverity = (groupId: string): Severity =>
    groupMembers(groupId).reduce<Severity>((max, issue) => (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[max] ? issue.severity : max), 'minor');
  const selectedGroupMembers = createMemo(() => {
    const issue = selected();
    return issue && !issue.canonicalId ? groupMembers(issue.groupId).filter((member) => member.id !== issue.id) : [];
  });
  const canonicalOf = (issue: AuditIssue) => (issue.canonicalId ? state.issues.find((item) => item.id === issue.canonicalId) : undefined);
  const mergeTargets = createMemo(() => {
    const issue = selected();
    return state.issues.filter((item) => !item.canonicalId && item.id !== issue?.id && item.id !== issue?.canonicalId);
  });

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const addEvent = (issueId: string, message: string) => setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message }, ...events]);
  const selectIssue = (id: string) => { setSelectedId(id); setActionError(''); };

  // 主问题状态改动后重算组内重复问题：向前跟随主问题；重新打开时已关闭的一起回来；
  // 已进入待复测/已关闭的重复问题不因组内重算而倒退
  const syncGroupStatus = (canonical: AuditIssue, to: IssueStatus, now: string) => {
    let synced = 0;
    let returned = 0;
    for (const member of groupMembers(canonical.groupId)) {
      if (member.id === canonical.id) continue;
      const next: IssueStatus = to === 'reopened' ? 'reopened' : STATUS_RANK[to] >= STATUS_RANK[member.status] ? to : member.status;
      if (next === member.status) continue;
      if (member.status === 'closed' && next === 'reopened') returned += 1;
      synced += 1;
      setState('issues', (issue) => issue.id === member.id, produce((issue) => { issue.status = next; issue.updatedAt = now; }));
    }
    return { synced, returned };
  };

  const applyTransition = (key: TransitionKey) => {
    const issue = selected();
    if (!issue) return;
    const def = TRANSITIONS[key];
    if (issue.canonicalId) { setActionError('该问题已并入主问题，状态由主问题统一流转，请切换到主问题操作。'); return; }
    if (role() !== def.role) { setActionError(`越权操作已拒绝：「${def.label}」需要${ROLE_LABEL[def.role]}，当前角色是${ROLE_LABEL[role()]}，状态未改变。`); return; }
    if (!def.from.includes(issue.status)) { setActionError(`当前状态「${STATUS_LABEL[issue.status]}」不能执行「${def.label}」，状态未改变。`); return; }
    const now = new Date().toISOString();
    setState('issues', (item) => item.id === issue.id, produce((draft) => { Object.assign(draft, def.patch, { status: def.to, updatedAt: now }); }));
    const { synced, returned } = syncGroupStatus(issue, def.to, now);
    let message = `${def.event}，主问题进入「${STATUS_LABEL[def.to]}」`;
    if (synced > 0) message += `，组内 ${synced} 个重复问题同步为「${STATUS_LABEL[def.to]}」`;
    if (returned > 0) message += `（其中 ${returned} 个已关闭重复问题一并回来）`;
    addEvent(issue.id, message);
    setActionError('');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    if (role() !== 'auditor') { setFormError(`越权操作已拒绝：创建问题需要审核员，当前角色是${ROLE_LABEL[role()]}，未创建任何问题。`); return; }
    const id = crypto.randomUUID();
    const issue: AuditIssue = { id, ...values, status: 'open', groupId: id, fixNote: '', retestNote: '', updatedAt: new Date().toISOString() };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    setFormError('');
    addEvent(issue.id, '审核员创建问题并保存证据，自成一组');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    if (!duplicate) return;
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (role() !== 'auditor') { setActionError(`越权操作已拒绝：合并重复问题需要审核员，当前角色是${ROLE_LABEL[role()]}，状态未改变。`); return; }
    if (!canonical || canonical.id === duplicate.id) { setActionError('请选择要并入的主问题。'); return; }
    if (canonical.canonicalId) { setActionError('只能选择主问题作为合并目标。'); return; }
    if (canonical.groupId === duplicate.groupId) { setActionError('两个问题已在同一组，无需合并。'); return; }
    const now = new Date().toISOString();
    const severityBefore = groupSeverity(canonical.groupId);
    // 若并入的是主问题，其组内重复问题一起并入；重复问题换主时只移动自己
    const moving = duplicate.canonicalId ? [duplicate] : groupMembers(duplicate.groupId);
    let kept = 0;
    for (const member of moving) {
      // 升档或合并不让已经进入待复测/已关闭的状态倒退
      const keepStatus = STATUS_RANK[canonical.status] < STATUS_RANK[member.status];
      if (keepStatus) kept += 1;
      setState('issues', (issue) => issue.id === member.id, produce((issue) => {
        issue.canonicalId = canonical.id;
        issue.groupId = canonical.groupId;
        if (!keepStatus) issue.status = canonical.status;
        issue.updatedAt = now;
      }));
    }
    const severityAfter = groupSeverity(canonical.groupId);
    let message = `审核员将《${duplicate.title}》并入主问题《${canonical.title}》（移动 ${moving.length} 条记录，原复现步骤与影响人群各自保留）`;
    if (SEVERITY_RANK[severityAfter] > SEVERITY_RANK[severityBefore]) message += `，组内出现更高严重程度，整组按最高档「${SEVERITY_LABEL[severityAfter]}」处理`;
    if (kept > 0) message += `，${kept} 条已进入待复测/已关闭的记录保持原状态不倒退`;
    addEvent(canonical.id, message);
    setActionError('');
    setMergeInto('');
    setSelectedId(canonical.id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
            <div role="group" aria-label="当前协作角色" style="display:flex;gap:6px">
              <For each={ROLE_ORDER}>{(item) => (
                <button type="button" class={role() === item ? '' : 'secondary'} aria-pressed={role() === item} onClick={() => setRole(item)}>{ROLE_LABEL[item]}</button>
              )}</For>
            </div>
            <button type="button" class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
          </div>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题（按主问题）</span><strong>{canonicals().length}</strong></div>
          <div class="card"><span>待修复</span><strong>{canonicals().filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{canonicals().filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{canonicals().filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>
        <p style="margin:-8px 0 14px;color:#5d7780">{duplicateCount()} 个重复问题已并入主问题，统计只按主问题计一次。</p>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue">
                <h3><button class="secondary" onClick={() => selectIssue(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class="badge">{STATUS_LABEL[issue.status]}</span>
                  <span class="badge">{SEVERITY_LABEL[issue.severity]}</span>
                  <span>{issue.flow}</span>
                  <span>{issue.impactGroup}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复 → {canonicalOf(issue)?.title}</span></Show>
                  <Show when={!issue.canonicalId && groupMembers(issue.groupId).length > 1}><span class="badge">主问题 · 组内 {groupMembers(issue.groupId).length - 1} 个重复</span></Show>
                  <Show when={!issue.canonicalId && groupSeverity(issue.groupId) !== issue.severity}><span class="badge">组内最高：{SEVERITY_LABEL[groupSeverity(issue.groupId)]}</span></Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(issue) => (
              <>
                <h3>{issue().title}</h3>
                <div class="meta">
                  <span class="badge">{STATUS_LABEL[issue().status]}</span>
                  <span class="badge">严重程度：{SEVERITY_LABEL[issue().severity]}</span>
                  <Show when={!issue().canonicalId && groupSeverity(issue().groupId) !== issue().severity}>
                    <span class="badge">组内最高：{SEVERITY_LABEL[groupSeverity(issue().groupId)]}（整组按最高档处理）</span>
                  </Show>
                </div>
                <p><strong>复现步骤：</strong>{issue().steps}</p>
                <p><strong>影响人群：</strong>{issue().impactGroup}</p>
                <p><strong>修复记录：</strong>{issue().fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue().retestNote || '尚未填写'}</p>
                <Show when={issue().canonicalId} fallback={
                  <>
                    <div role="group" aria-label="问题状态操作">
                      <button type="button" onClick={() => applyTransition('confirm')}>确认问题</button>{' '}
                      <button type="button" onClick={() => applyTransition('startFix')}>开始修复</button>{' '}
                      <button type="button" onClick={() => applyTransition('submitFix')}>提交复测</button>{' '}
                      <button type="button" onClick={() => applyTransition('pass')}>复测通过</button>{' '}
                      <button type="button" class="danger" onClick={() => applyTransition('fail')}>复测未通过 / 重新打开</button>
                    </div>
                    <p style="color:#5d7780">当前角色：{ROLE_LABEL[role()]}。审核员确认问题，开发人员推进已确认问题，复测人员关闭或重新打开；越权提交会被拒绝且状态不改。</p>
                    <Show when={selectedGroupMembers().length > 0}>
                      <h4>组内重复问题（{selectedGroupMembers().length}）</h4>
                      <For each={selectedGroupMembers()}>{(member) => (
                        <div class="issue">
                          <div class="meta"><strong>{member.title}</strong><span class="badge">{STATUS_LABEL[member.status]}</span><span class="badge">{SEVERITY_LABEL[member.severity]}</span></div>
                          <p><strong>复现步骤：</strong>{member.steps}</p>
                          <p><strong>影响人群：</strong>{member.impactGroup}</p>
                        </div>
                      )}</For>
                      <p style="color:#5d7780">重复问题的复现步骤与影响人群各自保留，统计只按主问题计一次。</p>
                    </Show>
                  </>
                }>
                  <p role="status">该问题已并入主问题《{canonicalOf(issue())?.title}》，状态跟随主问题流转，统计计入主问题；其复现步骤与影响人群在此保留。</p>
                  <button type="button" onClick={() => selectIssue(issue().canonicalId!)}>查看主问题</button>
                </Show>
                <Show when={actionError()}><p class="error" role="alert">{actionError()}</p></Show>
                <hr />
                <label>合并到主问题（需审核员）<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择主问题</option><For each={mergeTargets()}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button type="button" disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>
            )}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <p style="color:#5d7780">创建问题需要审核员角色，当前角色：{ROLE_LABEL[role()]}。</p>
            <AuditForm onSubmit={createIssue} style="margin-top:12px" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => field.value = event.currentTarget.value} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field) => <label>影响人群<select value={field.value} onChange={(event) => field.value = event.currentTarget.value}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field) => <label>严重程度<select value={field.value} onChange={(event) => field.value = event.currentTarget.value as Severity}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <Show when={formError()}><p class="error" role="alert">{formError()}</p></Show>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => {
                const issue = state.issues.find((item) => item.id === event.issueId);
                return <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{issue ? `【${issue.title}】` : ''}{event.message}</div></div>;
              }}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
