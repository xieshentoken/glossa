import type { Effort, ModelInfo, UiLang } from './types';

const en = {
  title: 'Model connections', add: 'Add connection', name: 'Connection name', provider: 'Provider',
  clearKey: 'Clear key', remove: 'Remove connection', removePlaintext: 'Remove legacy unencrypted keys', cleared: 'Key cleared.', confirmClear: 'Clear the key for this connection?', confirmRemove: 'Remove this connection and its saved key?',
  key: 'API key', existingKey: 'Leave blank to keep the saved key', address: 'API base URL', protocol: 'API protocol',
  test: 'Test connection & get models', testing: 'Getting models…', save: 'Verify & save', saving: 'Verifying selected model…', cancel: 'Cancel', edit: 'Edit',
  model: 'Model', effort: 'Effort', defaultEffort: 'Provider default', thinkingOn: 'Thinking on', thinkingOff: 'Thinking off',
  apiSource: 'Model list received. The selected model will be verified when you save.',
  documentedSource: 'This endpoint has no model list. Showing documented candidates; access will be verified when you save.',
  manualSource: 'This endpoint has no model list. Enter a model ID; access will be verified when you save.',
  emptySource: 'No text models were returned. Check model permissions at the provider.',
  manual: 'Enter model ID manually', apiEffort: 'Effort options reported by the API', documentedEffort: 'Effort options from provider documentation',
  unknownEffort: 'Effort capability is unknown. The provider default will be used.',
  testCost: 'Getting models sends no document text. Saving makes one short model request and may incur a small charge.',
  session: 'Keep key for this session only', protected: 'Save key using system-protected storage',
  noProtection: 'Protected storage is unavailable. Keys can only be kept for this session.',
  useFor: 'Use this connection for', useNone: 'Save without changing defaults', useQuick: 'Quick explanation', useDirect: 'Skill explanations', useBoth: 'Quick & skill explanations',
  goPending: 'OpenCode Go is reserved. Its documentation requires coding-agent traffic; reader use is not confirmed. No key will be sent.',
  docs: 'Provider documentation', saved: 'Connection saved and the selected model verified.', legacy: 'Existing configuration — edit to discover models',
  noKey: 'No saved key', storedKey: 'Protected key saved', sessionKey: 'Key available this session', plainKey: 'Legacy unencrypted key',
  changed: 'Connection details changed. Test again before saving.', defaultsHint: 'Choose a saved connection. Model and effort come from that connection; edit it under Model connections.',
};
type Copy = typeof en;
const zh: Copy = {
  title: '模型连接', add: '添加配置', name: '配置名称', provider: '服务商', key: 'API key', existingKey: '留空则保留已保存的 key', address: 'API 请求地址', protocol: 'API 协议',
  clearKey: '清除 key', remove: '删除配置', removePlaintext: '删除旧版未加密密钥', cleared: 'Key 已清除。', confirmClear: '清除此配置的 key？', confirmRemove: '删除此配置及其已保存的 key？',
  test: '测试连接并获取模型', testing: '正在获取模型…', save: '验证并保存', saving: '正在验证所选模型…', cancel: '取消', edit: '编辑',
  model: '模型', effort: 'Effort', defaultEffort: '服务商默认', thinkingOn: '开启思考', thinkingOff: '关闭思考',
  apiSource: '已获取模型列表。保存时将验证所选模型与 effort。',
  documentedSource: '此接口不提供模型列表，以下是官方文档中的候选模型；保存时将验证调用权限。',
  manualSource: '此接口不提供模型列表，请填写模型 ID；保存时将验证调用权限。',
  emptySource: '接口未返回可用的文本模型，请检查服务商的模型权限。', manual: '手动输入模型 ID',
  apiEffort: 'Effort 选项来自 API', documentedEffort: 'Effort 选项来自服务商文档', unknownEffort: 'Effort 能力未知，将使用服务商默认值。',
  testCost: '获取模型时不发送文档正文。保存时会发送一次简短的模型测试请求，可能产生少量费用。',
  session: 'Key 仅本次会话有效', protected: '使用系统受保护存储保存 key', noProtection: '系统受保护存储不可用，key 只能在本次会话使用。',
  useFor: '将此配置用于', useNone: '仅保存，不更改默认配置', useQuick: '速览解释', useDirect: '技能解释', useBoth: '速览和技能解释',
  goPending: '已保留 OpenCode Go 预设。官方要求编程 Agent 流量，阅读器用途尚未确认，暂不发送 key。', docs: '服务商官方文档',
  saved: '配置已保存，所选模型已通过验证。', legacy: '已有配置，编辑后可获取模型列表', noKey: '未保存 key', storedKey: 'Key 已受保护保存', sessionKey: 'Key 本次会话可用', plainKey: '旧版未加密 key',
  changed: '连接信息已更改，请重新测试后再保存。', defaultsHint: '选择已保存的配置即可使用其中的模型和 effort；修改请前往“模型连接”。',
};
const de: Copy = {
  ...en, title: 'Modellverbindungen', add: 'Verbindung hinzufügen', name: 'Verbindungsname', provider: 'Anbieter',
  clearKey: 'Schlüssel löschen', remove: 'Verbindung entfernen', removePlaintext: 'Alte unverschlüsselte Schlüssel entfernen', cleared: 'Schlüssel gelöscht.', confirmClear: 'Schlüssel dieser Verbindung löschen?', confirmRemove: 'Verbindung und gespeicherten Schlüssel entfernen?',
  existingKey: 'Leer lassen, um den gespeicherten Schlüssel zu behalten', address: 'API-Basis-URL', protocol: 'API-Protokoll',
  test: 'Verbindung testen und Modelle laden', testing: 'Modelle werden geladen…', save: 'Prüfen und speichern', saving: 'Modell wird geprüft…', cancel: 'Abbrechen', edit: 'Bearbeiten',
  model: 'Modell', defaultEffort: 'Anbieterstandard', thinkingOn: 'Denken an', thinkingOff: 'Denken aus',
  apiSource: 'Modellliste geladen. Beim Speichern werden Modell und Effort geprüft.', documentedSource: 'Keine Modellliste. Dokumentierte Kandidaten werden beim Speichern geprüft.', manualSource: 'Keine Modellliste. Modell-ID eingeben; der Zugriff wird beim Speichern geprüft.', emptySource: 'Keine Textmodelle erhalten. Modellberechtigungen prüfen.',
  manual: 'Modell-ID manuell eingeben', apiEffort: 'Effort-Optionen laut API', documentedEffort: 'Effort-Optionen laut Anbieterdokumentation', unknownEffort: 'Effort unbekannt. Der Anbieterstandard wird verwendet.',
  testCost: 'Die Modellabfrage sendet keinen Dokumenttext. Beim Speichern kann eine kurze Testanfrage geringe Kosten verursachen.',
  session: 'Schlüssel nur für diese Sitzung', protected: 'Schlüssel systemgeschützt speichern', noProtection: 'Geschützter Speicher ist nicht verfügbar. Schlüssel gelten nur für diese Sitzung.',
  useFor: 'Verbindung verwenden für', useNone: 'Ohne Änderung der Standards speichern', useQuick: 'Schnellerklärung', useDirect: 'Skill-Erklärungen', useBoth: 'Schnell- und Skill-Erklärungen',
  goPending: 'OpenCode Go ist reserviert. Laut Dokumentation ist Coding-Agent-Verkehr erforderlich; die Reader-Nutzung ist ungeklärt. Kein Schlüssel wird gesendet.', docs: 'Anbieterdokumentation', saved: 'Verbindung gespeichert und Modell geprüft.', legacy: 'Bestehende Konfiguration – zum Laden der Modelle bearbeiten', noKey: 'Kein Schlüssel', storedKey: 'Schlüssel geschützt gespeichert', sessionKey: 'Schlüssel für diese Sitzung', plainKey: 'Alter unverschlüsselter Schlüssel', changed: 'Verbindungsdaten geändert. Erneut testen.', defaultsHint: 'Gespeicherte Verbindung wählen. Modell und Effort werden daraus übernommen; Änderungen unter Modellverbindungen.',
};
const fr: Copy = {
  ...en, title: 'Connexions aux modèles', add: 'Ajouter une connexion', name: 'Nom de la connexion', provider: 'Fournisseur',
  clearKey: 'Effacer la clé', remove: 'Supprimer la connexion', removePlaintext: 'Supprimer les anciennes clés non chiffrées', cleared: 'Clé effacée.', confirmClear: 'Effacer la clé de cette connexion ?', confirmRemove: 'Supprimer cette connexion et sa clé enregistrée ?',
  existingKey: 'Laisser vide pour conserver la clé enregistrée', address: 'URL de base API', protocol: 'Protocole API',
  test: 'Tester et charger les modèles', testing: 'Chargement des modèles…', save: 'Vérifier et enregistrer', saving: 'Vérification du modèle…', cancel: 'Annuler', edit: 'Modifier',
  model: 'Modèle', defaultEffort: 'Valeur par défaut du fournisseur', thinkingOn: 'Réflexion activée', thinkingOff: 'Réflexion désactivée',
  apiSource: 'Liste reçue. Le modèle et son effort seront vérifiés à l’enregistrement.', documentedSource: 'Aucune liste disponible. Les modèles documentés seront vérifiés à l’enregistrement.', manualSource: 'Aucune liste disponible. Saisir un identifiant de modèle ; son accès sera vérifié à l’enregistrement.', emptySource: 'Aucun modèle texte reçu. Vérifier les autorisations.',
  manual: 'Saisir un identifiant manuellement', apiEffort: 'Efforts indiqués par l’API', documentedEffort: 'Efforts indiqués par la documentation', unknownEffort: 'Effort inconnu. La valeur par défaut du fournisseur sera utilisée.',
  testCost: 'La liste ne transmet aucun document. L’enregistrement envoie une courte requête de test pouvant entraîner un faible coût.',
  session: 'Clé pour cette session uniquement', protected: 'Enregistrer la clé dans le stockage protégé du système', noProtection: 'Stockage protégé indisponible. La clé ne sera conservée que pour cette session.',
  useFor: 'Utiliser cette connexion pour', useNone: 'Enregistrer sans changer les valeurs par défaut', useQuick: 'Explication rapide', useDirect: 'Explications des skills', useBoth: 'Explications rapides et skills',
  goPending: 'Préréglage OpenCode Go réservé. La documentation exige un trafic d’agent de programmation ; l’usage en lecture reste à confirmer. Aucune clé envoyée.', docs: 'Documentation du fournisseur', saved: 'Connexion enregistrée et modèle vérifié.', legacy: 'Configuration existante — modifier pour charger les modèles', noKey: 'Aucune clé', storedKey: 'Clé enregistrée et protégée', sessionKey: 'Clé disponible pour cette session', plainKey: 'Ancienne clé non chiffrée', changed: 'Connexion modifiée. Relancer le test.', defaultsHint: 'Choisir une connexion enregistrée. Elle fournit le modèle et l’effort ; modifier dans Connexions aux modèles.',
};
export function connectionCopy(lang: UiLang): Copy { return ({ en, zh, de, fr })[lang]; }
export function effortLabel(lang: UiLang, effort: Effort, thinking?: ModelInfo['thinking']): string {
  const c = connectionCopy(lang);
  return effort === 'default' ? c.defaultEffort : thinking === 'toggle' ? effort === 'none' ? c.thinkingOff : c.thinkingOn : effort;
}
