import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';

type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
type Role = 'auditor' | 'developer' | 'retester';
type TransitionTarget = 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';

interface AuditIssue {
  id: string;
  groupId: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
}
interface AuditEvent { id: string; at: string; issueId: string; message: string }
interface WorkbenchState { issues: AuditIssue[]; events: AuditEvent[] }

const seed: WorkbenchState = {
  issues: [
    { id: 'issue-1', groupId: 'grp-issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
    { id: 'issue-2', groupId: 'grp-issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString() }
  ],
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
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

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待分诊', triaged: '已确认', fixing: '修复中', verifying: '待复测', closed: '已关闭', reopened: '重新打开'
};
const SEVERITY_LABELS: Record<Severity, string> = {
  critical: '阻断', serious: '严重', moderate: '中等', minor: '轻微'
};
const ROLE_LABELS: Record<Role, string> = { auditor: '审核员', developer: '开发人员', retester: '复测人员' };
const ACTION_LABELS: Record<TransitionTarget, string> = {
  triaged: '确认问题', fixing: '开始修复', verifying: '提交复测', closed: '复测通过', reopened: '复测失败'
};
/** 各状态档位：重算重复项状态时只允许前进，不允许倒退（重新打开除外）。 */
const STATUS_RANK: Record<IssueStatus, number> = {
  open: 0, triaged: 1, reopened: 2, fixing: 3, verifying: 4, closed: 5
};
const SEVERITY_RANK: Record<Severity, number> = { minor: 0, moderate: 1, serious: 2, critical: 3 };
/** 各操作允许的角色：审核员创建/确认/合并，开发人员推进已确认问题，复测人员关闭或重开。 */
const ALLOWED_ROLES: Record<TransitionTarget, Role[]> = {
  triaged: ['auditor'],
  fixing: ['developer'],
  verifying: ['developer'],
  closed: ['retester'],
  reopened: ['retester']
};

function higherSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** 旧数据升级：补齐组标识（groupId），不重写任何原有记录。 */
function migrateState(raw: unknown): WorkbenchState {
  const parsed = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorkbenchState>;
  const issues = Array.isArray(parsed.issues) ? (parsed.issues as AuditIssue[]) : seed.issues;
  const events = Array.isArray(parsed.events) ? (parsed.events as AuditEvent[]) : seed.events;
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const withGroup = issues.map((issue) => {
    if (typeof issue.groupId === 'string' && issue.groupId) return { ...issue };
    const anchor = issue.canonicalId ? byId.get(issue.canonicalId) : undefined;
    return { ...issue, groupId: anchor?.groupId ?? `grp-${issue.canonicalId ?? issue.id}` };
  });
  // 二次归并：有主问题标识的记录必须与主问题同组。
  return {
    issues: withGroup.map((issue) => {
      if (!issue.canonicalId) return issue;
      const canonical = withGroup.find((item) => item.id === issue.canonicalId);
      return canonical ? { ...issue, groupId: canonical.groupId } : issue;
    }),
    events
  };
}

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const raw = JSON.parse(localStorage.getItem('a11y-audit-v1') ?? 'null');
    return migrateState(raw);
  } catch {
    return seed;
  }
}

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [role, setRole] = createSignal<Role>('auditor');
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  /** 统计只按主问题计：每个重复组合计一次。 */
  const canonicals = createMemo(() => state.issues.filter((issue) => !issue.canonicalId));

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('a11y-audit-v1', JSON.stringify(state));
  });

  const addEvent = (issueId: string, message: string) => setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message }, ...events]);

  const createIssue = (values: IssueForm) => {
    if (role() !== 'auditor') {
      addEvent('', `越权操作被拒绝：${ROLE_LABELS[role()]}无权创建问题，状态未变更`);
      return;
    }
    const id = crypto.randomUUID();
    const issue: AuditIssue = { id, groupId: `grp-${id}`, ...values, status: 'open', fixNote: '', retestNote: '', updatedAt: new Date().toISOString() };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, '审计员创建问题并保存证据');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  /** 主问题状态变更：组内其他问题按档位重算，越权拒绝且状态不改。 */
  const transition = (issueId: string, next: TransitionTarget, patch: Partial<AuditIssue>, message: string) => {
    const target = state.issues.find((issue) => issue.id === issueId);
    if (!target) return;
    const canonical = target.canonicalId ? state.issues.find((issue) => issue.id === target.canonicalId) : target;
    if (!canonical) return;
    const members = state.issues.filter((issue) => issue.groupId === canonical.groupId);
    const now = new Date().toISOString();

    if (!ALLOWED_ROLES[next].includes(role())) {
      addEvent(canonical.id, `越权操作被拒绝：${ROLE_LABELS[role()]}无权「${ACTION_LABELS[next]}」，组内状态未变更`);
      return;
    }

    setState('issues', (issues) => issues.map((issue) => {
      if (issue.id === canonical.id) {
        return { ...issue, status: next, ...patch, updatedAt: now };
      }
      if (issue.groupId === canonical.groupId) {
        // 重新打开：已关闭的重复问题一起回来；其余情况只允许前进，待复测不倒退。
        const nextStatus = next === 'reopened' ? 'reopened' : (STATUS_RANK[issue.status] >= STATUS_RANK[next] ? issue.status : next);
        return { ...issue, status: nextStatus, updatedAt: now };
      }
      return issue;
    }));

    addEvent(canonical.id, message);
    members.filter((member) => member.id !== canonical.id).forEach((member) => {
      addEvent(member.id, `随主问题「${canonical.title}」同步状态为「${STATUS_LABELS[next]}」，复现步骤与影响人群各自保留`);
    });
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  /** 合并重复问题到主问题：同组标识、严重程度按最高档，状态不重写。 */
  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id || duplicate.canonicalId) return;
    if (role() !== 'auditor') {
      addEvent(duplicate.id, `越权操作被拒绝：${ROLE_LABELS[role()]}无权合并重复问题，状态未变更`);
      return;
    }
    const groupSeverity = state.issues
      .filter((issue) => issue.groupId === canonical.groupId)
      .reduce((max, issue) => higherSeverity(max, issue.severity), higherSeverity(canonical.severity, duplicate.severity));
    const now = new Date().toISOString();
    setState('issues', (issues) => issues.map((issue) => {
      if (issue.id === duplicate.id) return { ...issue, canonicalId: canonical.id, groupId: canonical.groupId, updatedAt: now };
      if (issue.id === canonical.id) return { ...issue, severity: groupSeverity, updatedAt: now };
      return issue;
    }));
    addEvent(canonical.id, `重复问题「${duplicate.title}」并入本组，组内严重程度按最高档「${SEVERITY_LABELS[groupSeverity]}」计算`);
    addEvent(duplicate.id, `已合并到主问题「${canonical.title}」；复现步骤与影响人群各自保留`);
    setSelectedId(canonical.id);
    setMergeInto('');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const can = (action: TransitionTarget) => ALLOWED_ROLES[action].includes(role());

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
          <div class="hero-actions">
            <label class="role-switcher">当前角色
              <select value={role()} onChange={(event) => setRole(event.currentTarget.value as Role)}>
                <option value="auditor">审核员（创建 / 确认 / 合并）</option>
                <option value="developer">开发人员（开始修复 / 提交复测）</option>
                <option value="retester">复测人员（关闭 / 重新打开）</option>
              </select>
            </label>
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
          </div>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题（按组计一次）</span><strong>{canonicals().length}</strong></div>
          <div class="card"><span>待修复</span><strong>{canonicals().filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{canonicals().filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{canonicals().filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => {
              const canonical = () => (issue.canonicalId ? state.issues.find((item) => item.id === issue.canonicalId) : undefined);
              return (
                <article class="issue">
                  <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                  <div class="meta">
                    <span class="badge">{STATUS_LABELS[issue.status]}</span>
                    <span class="badge">严重程度：{SEVERITY_LABELS[issue.severity]}</span>
                    <span>{issue.flow}</span>
                    <span>{issue.impactGroup}</span>
                    <Show when={issue.canonicalId}>
                      <span class="badge">重复项 → {canonical()?.title ?? '主问题'}</span>
                    </Show>
                  </div>
                </article>
              );
            }}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              const canonical = () => (issue.canonicalId ? state.issues.find((item) => item.id === issue.canonicalId) : undefined);
              return (
                <>
                  <Show when={canonical()}>
                    <p class="notice" role="status">这是主问题「{canonical()!.title}」的重复项：状态操作将作用于主问题，组内其他问题自动重算，复现步骤与影响人群各自保留。</p>
                  </Show>
                  <h3>{issue.title}</h3>
                  <p><strong>复现步骤：</strong>{issue.steps}</p>
                  <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                  <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                  <p class="meta">
                    <span class="badge">当前状态：{STATUS_LABELS[issue.status]}</span>
                    <span class="badge">组内严重程度：{SEVERITY_LABELS[issue.severity]}</span>
                  </p>
                  <div role="group" aria-label="问题状态操作">
                    <button disabled={!can('triaged')} title={can('triaged') ? '' : '仅审核员可确认问题'} onClick={() => transition(issue.id, 'triaged', {}, '审核员完成分诊')}>确认问题</button>{' '}
                    <button disabled={!can('fixing')} title={can('fixing') ? '' : '仅开发人员可开始修复'} onClick={() => transition(issue.id, 'fixing', { fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>开始修复</button>{' '}
                    <button disabled={!can('verifying')} title={can('verifying') ? '' : '仅开发人员可提交复测'} onClick={() => transition(issue.id, 'verifying', {}, '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                    <button disabled={!can('closed')} title={can('closed') ? '' : '仅复测人员可关闭问题'} onClick={() => transition(issue.id, 'closed', { retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}>复测通过</button>{' '}
                    <button class="danger" disabled={!can('reopened')} title={can('reopened') ? '' : '仅复测人员可重新打开'} onClick={() => transition(issue.id, 'reopened', { retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开，组内已关闭问题一起回来')}>复测失败</button>
                  </div>
                  <p class="meta">权限：审核员创建 / 确认 / 合并，开发人员推进已确认问题，复测人员关闭或重新打开；越权操作将被拒绝且状态不变。</p>
                  <hr />
                  <label>合并到主问题
                    <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                      <option value="">选择问题</option>
                      <For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                    </select>
                  </label>
                  <button disabled={!mergeInto() || !can('triaged') || !!issue.canonicalId} title={!can('triaged') ? '仅审核员可合并重复问题' : issue.canonicalId ? '重复项请先在主问题下管理' : ''} onClick={mergeDuplicate}>确认重复合并</button>
                </>
              );
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <fieldset disabled={role() !== 'auditor'}>
              <Show when={role() !== 'auditor'}><p class="notice" role="status">当前角色为{ROLE_LABELS[role()]}，仅审核员可创建问题。</p></Show>
              <AuditForm onSubmit={createIssue} style="margin-top:12px">
                <AuditField name="title">{(field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value ?? ''} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label>}</AuditField>
                <AuditField name="flow">{(field, props) => <label>业务流程<input {...props} value={field.value ?? ''} /></label>}</AuditField>
                <AuditField name="steps">{(field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value ?? ''} /></label>}</AuditField>
                <AuditField name="impactGroup">{(field, props) => <label>影响人群<select {...props} value={field.value ?? ''}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label>}</AuditField>
                <AuditField name="severity">{(field, props) => <label>严重程度<select {...props} value={field.value ?? 'serious'}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label>}</AuditField>
                <button type="submit">创建问题</button>
              </AuditForm>
            </fieldset>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
