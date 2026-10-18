// Native dialogs owned by the main process. The renderer cannot answer them,
// so a compromised or buggy renderer cannot grant itself permissions.

import { dialog, type BrowserWindow } from 'electron';
import { translator } from '../shared/i18n';
import type { Settings } from '../shared/types';
import type { AgentApprover } from './agent-policy';
import type { GrantConfirm } from './settings-policy';

export function agentApprovalDialog(win: () => BrowserWindow | null, settings: () => Settings): AgentApprover {
  return async (r) => {
    const t = translator(settings().uiLang);
    const w = win();
    const opts = {
      type: 'warning' as const,
      title: t('dlgAgentTitle'),
      message: t('dlgAgentMessage', { skill: r.skill, harness: r.harness }),
      detail: [
        `${t('dlgSkillSource')}: ${r.skill} (${r.skillSource}, ${r.skillHash.slice(0, 12)})`,
        `${t('dlgCommand')}: ${r.command}`,
        `${t('dlgModel')}: ${r.model || '—'}`,
        `${t('dlgSendsTo')}: ${r.recipient}`,
        `${t('dlgFolder')}: ${r.workspace}`,
        `${t('dlgIsolation')}: ${r.isolation.detail}`,
      ].join('\n\n'),
      buttons: [t('dlgRun'), t('cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      checkboxLabel: t('dlgRemember'),
      checkboxChecked: false,
    };
    const res = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return { approved: res.response === 0, remember: res.response === 0 && res.checkboxChecked };
  };
}

export function grantDialog(win: () => BrowserWindow | null): GrantConfirm {
  return async (grant, s) => {
    const t = translator(s.uiLang);
    const [title, detail] = grant === 'document' ? [t('dlgGrantDocumentTitle'), t('dlgGrantDocument')] : [t('dlgGrantAgentsTitle'), t('dlgGrantAgents')];
    const opts = { type: 'warning' as const, title, message: title, detail, buttons: [t('dlgAllow'), t('cancel')], defaultId: 1, cancelId: 1, noLink: true };
    const w = win();
    const res = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return res.response === 0;
  };
}
