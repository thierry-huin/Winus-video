// QC Editorial — dedicated Quality Control app. Reuses the same WS/mediasoup
// signaling + JWT auth as web/viewer.js (same backend, same localStorage
// token keys), but is a completely separate page/role set (qc_coordinator/
// qc_supervisor/qc_engineer/qc_auditor) -- see the plan this was built from.
const baseUrl = `${location.protocol}//${location.host}`;
const wsUrl = `wss://${location.host}/ws`;
let ws, device, transport, authToken, userRole, currentUsername;
let requestSeq = 0;
const pending = new Map();
let lastStreams = [];

// ── i18n (es/pt/en) ──
// Every KEY mirrors the reference "QC Editorial" mockup's own key naming
// (catAudio, sevP1, stInAnalysis, etc.) where one exists, so this dictionary
// stays easy to cross-reference against that spec. Applied via [data-i18n]/
// [data-i18n-placeholder] attributes for static HTML, and the t() helper for
// JS-rendered strings. Covers all structural/chrome text (tabs, buttons,
// labels, column headers, category/severity/status labels, modal fields);
// a handful of longer-tail confirm()/alert() messages are still Spanish-only
// given scope, flagged inline where that's the case.
const I18N = {
  appTitle: { es: 'QC Editorial', pt: 'QC Editorial', en: 'QC Editorial' },
  loginSub: { es: 'Control de calidad editorial', pt: 'Controlo de qualidade editorial', en: 'Editorial quality control' },
  loginUser: { es: 'Usuario', pt: 'Utilizador', en: 'Username' },
  loginPass: { es: 'Contraseña', pt: 'Palavra-passe', en: 'Password' },
  loginEnter: { es: 'Entrar en la estación QC', pt: 'Entrar na estação QC', en: 'Enter QC station' },
  changePwTitle: { es: 'Define tu contraseña', pt: 'Define a tua palavra-passe', en: 'Set your password' },
  changePwHint: { es: 'La contraseña provisional solo sirve para la primera entrada. Elige una nueva.', pt: 'A palavra-passe provisória só serve para a primeira entrada. Escolhe uma nova.', en: 'The temporary password only works for the first sign-in. Choose a new one.' },
  pwCurrent: { es: 'Contraseña provisional', pt: 'Palavra-passe provisória', en: 'Temporary password' },
  pwNew: { es: 'Nueva contraseña (mín. 10, letras y números)', pt: 'Nova palavra-passe (mín. 10, letras e números)', en: 'New password (min. 10, letters and numbers)' },
  pwRepeat: { es: 'Repetir contraseña', pt: 'Repetir palavra-passe', en: 'Repeat password' },
  save: { es: 'Guardar', pt: 'Guardar', en: 'Save' },
  comsLink: { es: '↔ Coms', pt: '↔ Coms', en: '↔ Coms' },
  closeDay: { es: 'Cerrar el día', pt: 'Fechar o dia', en: 'Close the day' },
  logout: { es: 'Salir', pt: 'Terminar sessão', en: 'Sign out' },
  navMonitor: { es: 'Monitor', pt: 'Monitor', en: 'Monitor' },
  navIncidents: { es: 'Incidencias', pt: 'Ocorrências', en: 'Incidents' },
  navUsers: { es: 'Usuarios', pt: 'Utilizadores', en: 'Users' },
  layout1: { es: '1 feed', pt: '1 feed', en: '1 feed' },
  layout2: { es: '2 feeds', pt: '2 feeds', en: '2 feeds' },
  layout4: { es: '4 feeds', pt: '4 feeds', en: '4 feeds' },
  layout1_3: { es: '1 + 3', pt: '1 + 3', en: '1 + 3' },
  viewLabel: { es: 'Vista:', pt: 'Vista:', en: 'View:' },
  feedPickerPlaceholder: { es: '— elegir feed —', pt: '— escolher feed —', en: '— choose feed —' },
  noActiveFeedHint: { es: 'Elegí un feed activo (click en su cuadro) para marcar incidencias.', pt: 'Escolhe um feed ativo (clica no seu quadro) para marcar ocorrências.', en: 'Choose an active feed (click its box) to mark incidents.' },
  activeFeedLabel: { es: 'Feed activo:', pt: 'Feed ativo:', en: 'Active feed:' },
  sessionOpenBadge: { es: '● sesión abierta', pt: '● sessão aberta', en: '● session open' },
  noOpenSession: { es: 'sin sesión', pt: 'sem sessão', en: 'no session' },
  closeSessionBtn: { es: 'Cerrar sesión', pt: 'Fechar sessão', en: 'Close session' },
  openSessionBtn: { es: 'Abrir sesión', pt: 'Abrir sessão', en: 'Open session' },
  mark: { es: '📍 Marcar incidencia (M)', pt: '📍 Marcar ocorrência (M)', en: '📍 Mark incident (M)' },
  noActiveFeedAlert: { es: 'Elegí primero un feed activo.', pt: 'Escolhe primeiro um feed ativo.', en: 'Choose an active feed first.' },
  noSessionAlert: { es: 'No hay sesión abierta. Pedí al coordinador que abra una.', pt: 'Não há sessão aberta. Pede ao coordenador para abrir uma.', en: 'There is no open session. Ask the coordinator to open one.' },
  markFailedAlert: { es: 'No se pudo marcar la incidencia', pt: 'Não foi possível marcar a ocorrência', en: 'Could not mark the incident' },
  noSignal: { es: 'SIN SEÑAL', pt: 'SEM SINAL', en: 'NO SIGNAL' },
  statusAll: { es: 'Todos los estados', pt: 'Todos os estados', en: 'All statuses' },
  statusOpen: { es: 'Abierta', pt: 'Aberta', en: 'Open' },
  stInAnalysis: { es: 'En análisis', pt: 'Em análise', en: 'In review' },
  stNotified: { es: 'Notificado a la venue', pt: 'Notificado à venue', en: 'Venue notified' },
  stResolved: { es: 'Resuelto', pt: 'Resolvido', en: 'Resolved' },
  showVoided: { es: 'Mostrar anuladas', pt: 'Mostrar anuladas', en: 'Show voided' },
  pendingOnlyFilter: { es: 'Solo por describir', pt: 'Só por descrever', en: 'Pending only' },
  dayReport: { es: 'Informe del día', pt: 'Relatório do dia', en: 'Day report' },
  pendingTag: { es: 'por describir', pt: 'por descrever', en: 'to describe' },
  voidedTag: { es: 'anulada', pt: 'anulada', en: 'voided' },
  voidedByLabel: { es: 'Anulada por', pt: 'Anulada por', en: 'Voided by' },
  noDescription: { es: '(sin descripción)', pt: '(sem descrição)', en: '(no description)' },
  describeBtn: { es: 'Describir', pt: 'Descrever', en: 'Describe' },
  editBtn: { es: 'Editar', pt: 'Editar', en: 'Edit' },
  voidBtn: { es: 'Anular', pt: 'Anular', en: 'Void' },
  deleteBtn: { es: 'Eliminar', pt: 'Apagar', en: 'Delete' },
  voidReasonPrompt: { es: 'Motivo de la anulación:', pt: 'Motivo da anulação:', en: 'Reason for voiding:' },
  confirmDeleteIncident: { es: '¿Borrar esta incidencia?', pt: 'Apagar esta ocorrência?', en: 'Delete this incident?' },
  deleteFailedAlert: { es: 'No se pudo borrar', pt: 'Não foi possível apagar', en: 'Could not delete' },
  noIncidentsYet: { es: 'Todavía no hay incidencias.', pt: 'Ainda não há ocorrências.', en: 'No incidents yet.' },
  noSessionsYet: { es: 'Todavía no hay sesiones.', pt: 'Ainda não há sessões.', en: 'No sessions yet.' },
  sessionsByFeed: { es: 'Sesiones por feed', pt: 'Sessões por feed', en: 'Sessions by feed' },
  showArchive: { es: 'Mostrar sesiones cerradas', pt: 'Mostrar sessões fechadas', en: 'Show closed sessions' },
  colFeed: { es: 'Feed', pt: 'Feed', en: 'Feed' },
  colSession: { es: 'Sesión', pt: 'Sessão', en: 'Session' },
  colStatus: { es: 'Estado', pt: 'Estado', en: 'Status' },
  colOpenedBy: { es: 'Abierta por', pt: 'Aberta por', en: 'Opened by' },
  colActions: { es: 'Acciones', pt: 'Ações', en: 'Actions' },
  colTime: { es: 'Hora', pt: 'Hora', en: 'Time' },
  colCategory: { es: 'Categoría', pt: 'Categoria', en: 'Category' },
  colSeverity: { es: 'Severidad', pt: 'Severidade', en: 'Severity' },
  colDescription: { es: 'Descripción', pt: 'Comentário', en: 'Description' },
  colOperator: { es: 'Operador', pt: 'Operador', en: 'Operator' },
  sessionOpenState: { es: 'abierta', pt: 'aberta', en: 'open' },
  sessionClosedState: { es: 'cerrada', pt: 'fechada', en: 'closed' },
  reportBtn: { es: 'Informe', pt: 'Relatório', en: 'Report' },
  deleteSessionBtn: { es: 'Borrar', pt: 'Apagar', en: 'Delete' },
  confirmCloseSession: { es: '¿Cerrar esta sesión? Dejará de aceptar nuevas incidencias.', pt: 'Fechar esta sessão? Deixa de aceitar novas ocorrências.', en: 'Close this session? It will stop accepting new incidents.' },
  confirmCloseDay: { es: '¿Cerrar todas las sesiones abiertas?', pt: 'Fechar todas as sessões abertas?', en: 'Close all open sessions?' },
  askDayReport: { es: 'Sesiones cerradas. ¿Abrir el informe consolidado del día?', pt: 'Sessões fechadas. Abrir o relatório consolidado do dia?', en: 'Sessions closed. Open the consolidated report for the day?' },
  confirmDeleteSession: { es: '¿Borrar esta sesión y todas sus incidencias? No se puede deshacer. ¿Ya exportaste el informe?', pt: 'Apagar esta sessão e todas as suas ocorrências? Não se pode desfazer. Já exportaste o relatório?', en: 'Delete this session and all its incidents? This cannot be undone. Did you export the report?' },
  noSessionOpenAlert: { es: 'No se pudo abrir la sesión', pt: 'Não foi possível abrir a sessão', en: 'Could not open the session' },
  usersTitle: { es: 'Gestión de usuarios QC', pt: 'Gestão de utilizadores QC', en: 'QC user management' },
  deactivateTemp: { es: 'Desactivar temporales', pt: 'Desativar temporárias', en: 'Disable temporary accounts' },
  createUser: { es: '+ Nuevo usuario', pt: '+ Novo utilizador', en: '+ New user' },
  username: { es: 'Usuario', pt: 'Utilizador', en: 'Username' },
  role: { es: 'Rol', pt: 'Função', en: 'Role' },
  permanentAccount: { es: 'Cuenta permanente', pt: 'Conta permanente', en: 'Permanent account' },
  cancel: { es: 'Cancelar', pt: 'Cancelar', en: 'Cancel' },
  create: { es: 'Crear', pt: 'Criar', en: 'Create' },
  colPermanent: { es: 'Permanente', pt: 'Permanente', en: 'Permanent' },
  colTemporary: { es: 'Temporal', pt: 'Temporária', en: 'Temporary' },
  colActive: { es: 'Activo', pt: 'Ativo', en: 'Active' },
  colInactive: { es: 'Desactivado', pt: 'Desativado', en: 'Disabled' },
  resetPw: { es: '🔑 Reset', pt: '🔑 Repor', en: '🔑 Reset' },
  deactivate: { es: 'Desactivar', pt: 'Desativar', en: 'Deactivate' },
  activate: { es: 'Activar', pt: 'Ativar', en: 'Activate' },
  confirmDeactivateTemp: { es: '¿Desactivar todas las cuentas no permanentes (excepto supervisores)?', pt: 'Desativar todas as contas não permanentes (exceto supervisores)?', en: 'Disable all non-permanent accounts (except supervisors)?' },
  confirmDeleteUser: { es: '¿Borrar este usuario? Sus incidencias se conservan, con el nombre.', pt: 'Apagar este utilizador? As ocorrências dele ficam guardadas, com o nome.', en: 'Delete this user? Their incidents are kept, with their name.' },
  confirmResetPw: { es: '¿Generar una nueva contraseña provisional para', pt: 'Gerar uma nova palavra-passe provisória para', en: 'Generate a new temporary password for' },
  tempPwShown: { es: 'Contraseña provisional para', pt: 'Palavra-passe provisória para', en: 'Temporary password for' },
  tempPwHint: { es: 'aparece solo esta vez. Entregala por un canal seguro.', pt: 'aparece só esta vez. Entrega-a por um canal seguro.', en: 'shown only this once. Hand it over through a secure channel.' },
  createUserError: { es: 'Error al crear el usuario', pt: 'Erro ao criar o utilizador', en: 'Error creating user' },
  describeTitle: { es: 'Describir incidencia', pt: 'Descrever ocorrência', en: 'Describe incident' },
  captureSnapshot: { es: '📷 Capturar snapshot del feed activo', pt: '📷 Capturar imagem do feed ativo', en: '📷 Capture snapshot from active feed' },
  categoryLabel: { es: 'CATEGORÍA', pt: 'CATEGORIA', en: 'CATEGORY' },
  severityLabel: { es: 'SEVERIDAD', pt: 'SEVERIDADE', en: 'SEVERITY' },
  descPlaceholder: { es: 'Describí el problema...', pt: 'Descreve o problema...', en: 'Describe the issue...' },
  describeRequired: { es: 'Describí la incidencia.', pt: 'Descreve a ocorrência.', en: 'Describe the incident.' },
  saveFailedAlert: { es: 'No se pudo guardar', pt: 'Não foi possível guardar', en: 'Could not save' },
  catAudio: { es: 'Audio', pt: 'Áudio', en: 'Audio' },
  catDirection: { es: 'Realización', pt: 'Realização', en: 'Direction' },
  catGraphics: { es: 'Grafismo', pt: 'Grafismo', en: 'Graphics' },
  catNarrative: { es: 'Narrativa', pt: 'Narrativa', en: 'Narrative' },
  catReplays: { es: 'Repeticiones', pt: 'Replays', en: 'Replays' },
  catRules: { es: 'Normas del cliente', pt: 'Normas do cliente', en: 'Client rules' },
  sevP1: { es: 'P1 Crítica', pt: 'P1 Crítica', en: 'P1 Critical' },
  sevP2: { es: 'P2 Media', pt: 'P2 Média', en: 'P2 Medium' },
  sevP3: { es: 'P3 Baja', pt: 'P3 Baixa', en: 'P3 Low' },
  cancelBtn: { es: 'Cancelar', pt: 'Cancelar', en: 'Cancel' },
  closeBtn: { es: 'Cerrar', pt: 'Fechar', en: 'Close' },
  exportCsv: { es: 'Exportar CSV', pt: 'Exportar CSV', en: 'Export CSV' },
  exportPdf: { es: 'Exportar PDF (Imprimir)', pt: 'Exportar PDF (Imprimir)', en: 'Export PDF (Print)' },
  exportFailedAlert: { es: 'No se pudo exportar', pt: 'Não foi possível exportar', en: 'Export failed' },
  reportTotal: { es: 'Total de incidencias:', pt: 'Total de ocorrências:', en: 'Total incidents:' },
  reportSessionsTitle: { es: 'Sesiones', pt: 'Sessões', en: 'Sessions' },
  reportChronological: { es: 'Lista cronológica', pt: 'Lista cronológica', en: 'Chronological list' },
  dayReportTitle: { es: 'Informe del día', pt: 'Relatório do dia', en: 'Day report' },
  sessionReportTitle: { es: 'Informe de sesión', pt: 'Relatório de sessão', en: 'Session report' },
  alertAck: { es: 'Reconocer', pt: 'Reconhecer', en: 'Acknowledge' },
  language: { es: 'Idioma', pt: 'Idioma', en: 'Language' },
  muteTooltip: { es: 'Nivel de audio entrante (L/R)', pt: 'Nível de áudio de entrada (L/R)', en: 'Incoming audio level (L/R)' },
  fullscreenTooltip: { es: 'Pantalla completa', pt: 'Ecrã inteiro', en: 'Fullscreen' },
  // #20: severity/operator incident filters
  severityAll: { es: 'Todas las severidades', pt: 'Todas as severidades', en: 'All severities' },
  operatorAll: { es: 'Todos los operadores', pt: 'Todos os operadores', en: 'All operators' },
  // #22: editable session exec summary/recommendations
  execSummaryLabel: { es: 'Resumen ejecutivo', pt: 'Resumo executivo', en: 'Executive summary' },
  recommendationsLabel: { es: 'Recomendaciones', pt: 'Recomendações', en: 'Recommendations' },
  execSummaryPlaceholder: { es: 'Resumen ejecutivo de la sesión...', pt: 'Resumo executivo da sessão...', en: 'Executive summary of the session...' },
  recommendationsPlaceholder: { es: 'Recomendaciones...', pt: 'Recomendações...', en: 'Recommendations...' },
  saveNotes: { es: 'Guardar notas', pt: 'Guardar notas', en: 'Save notes' },
  saved: { es: 'Guardado ✓', pt: 'Guardado ✓', en: 'Saved ✓' },
  // #28: "Ver como" (view-as) role preview
  viewAsLabel: { es: 'Ver como', pt: 'Ver como', en: 'View as' },
  viewAsReal: { es: '— Mi rol real —', pt: '— A minha função real —', en: '— My real role —' },
  viewAsBanner: { es: '👁 Viendo la interfaz como: {role}', pt: '👁 A ver a interface como: {role}', en: '👁 Viewing the interface as: {role}' },
  exitPreview: { es: 'Salir de vista previa', pt: 'Sair da pré-visualização', en: 'Exit preview' },
  // #31: audit log + clip playback
  auditLogTitle: { es: 'Registro de auditoría', pt: 'Registo de auditoria', en: 'Audit log' },
  colActor: { es: 'Usuario', pt: 'Utilizador', en: 'User' },
  colAction: { es: 'Acción', pt: 'Ação', en: 'Action' },
  colTarget: { es: 'Objetivo', pt: 'Alvo', en: 'Target' },
  colDetails: { es: 'Detalles', pt: 'Detalhes', en: 'Details' },
  noAuditLogYet: { es: 'Todavía no hay registros de auditoría.', pt: 'Ainda não há registos de auditoria.', en: 'No audit log entries yet.' },
  clipBtn: { es: 'Clip', pt: 'Clip', en: 'Clip' },
  clipModalTitle: { es: 'Clip del incidente', pt: 'Clip da ocorrência', en: 'Incident clip' },
  clipNotReady: { es: 'El clip todavía no está listo o no existe para esta incidencia.', pt: 'O clip ainda não está pronto ou não existe para esta ocorrência.', en: 'The clip is not ready yet or does not exist for this incident.' },
};
let currentLang = localStorage.getItem('qc-lang') || 'es';
function t(key, vars) {
  const entry = I18N[key];
  let s = (entry && (entry[currentLang] || entry.es)) || key;
  if (vars) for (const k in vars) s = s.replace(`{${k}}`, vars[k]);
  return s;
}
function applyI18n() {
  document.documentElement.lang = currentLang;
  const sel = document.getElementById('lang-select');
  if (sel) sel.value = currentLang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  // Re-render whatever JS-built content is currently on screen so dynamic
  // strings (table rows, active-feed bar, etc.) pick up the new language too.
  renderActiveFeedBar();
  renderSessionBadges();
  renderP1Banner();
  renderViewAsBanner();
  const incidentsTab = document.getElementById('tab-incidents');
  if (incidentsTab && incidentsTab.classList.contains('active')) { loadIncidentsList(); loadSessionsTable(); }
  const usersTab = document.getElementById('tab-users');
  if (usersTab && usersTab.classList.contains('active')) loadQcUsers();
}
function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('qc-lang', lang);
  const sel = document.getElementById('lang-select');
  if (sel) sel.value = lang;
  applyI18n();
}

// ── Auth / bootstrapping ──
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('main-screen').style.display = 'none';
  const saved = localStorage.getItem('winus-video-token');
  if (saved) { authToken = saved; startApp(); }
}

async function doLogin() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value.trim();
  const errEl = document.getElementById('login-error');
  if (!user || !pass) { errEl.textContent = 'Completá usuario y contraseña'; return; }
  errEl.textContent = 'Conectando...';
  try {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      errEl.textContent = err.error || 'Credenciales inválidas';
      return;
    }
    const data = await res.json();
    // Only QC roles (plus admin/superadmin, which can also use the Coms
    // app -- see index.html's chooser) belong here; a viewer/publisher
    // account landing on qc.html by mistake (e.g. a stale bookmark) is
    // bounced straight back to the Coms app instead of a dead-end error.
    const qcRoles = ['qc_coordinator', 'qc_supervisor', 'qc_engineer', 'qc_auditor', 'admin', 'superadmin'];
    if (!qcRoles.includes(data.role)) {
      localStorage.setItem('winus-video-token', data.token);
      localStorage.setItem('winus-video-role', data.role);
      localStorage.setItem('winus-video-username', user);
      location.href = '/index.html';
      return;
    }
    authToken = data.token;
    userRole = data.role;
    currentUsername = user;
    localStorage.setItem('winus-video-token', authToken);
    localStorage.setItem('winus-video-role', userRole);
    localStorage.setItem('winus-video-username', currentUsername);
    if (data.mustChangePassword) { showForcedPasswordChange(); return; }
    startApp();
  } catch (e) {
    errEl.textContent = `Error: ${e.message}`;
  }
}

function logout() {
  localStorage.removeItem('winus-video-token');
  authToken = null;
  if (ws) ws.close();
  showLogin();
}

function startApp() {
  userRole = userRole || localStorage.getItem('winus-video-role');
  currentUsername = currentUsername || localStorage.getItem('winus-video-username') || '';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'block';
  document.getElementById('qc-username').textContent = currentUsername;
  const viewAsSelect = document.getElementById('view-as-select');
  if (viewAsSelect) viewAsSelect.style.display = canUseViewAs() ? 'inline-block' : 'none';
  applyRoleGatedUi();
  applyI18n();
  measureServerTimeOffset();
  connect();
  showTab('monitor');
}

// ── "Ver como" (#28): lets a supervisor/admin/superadmin preview the UI as
// one of the 4 QC roles, WITHOUT actually changing their real JWT/permissions
// -- the server always enforces the true role regardless (see index.js's
// authMiddleware, which never sees previewRole at all). This purely changes
// which buttons/tabs/sections THIS browser renders. Resets on reload --
// deliberately not persisted, so nobody is stuck "stuck" previewing after
// closing the tab.
let previewRole = null;
function canUseViewAs() { return ['qc_supervisor', 'admin', 'superadmin'].includes(userRole); }
function effectiveRole() { return previewRole || userRole; }
function isEffectiveSupervisor() { return ['qc_supervisor', 'admin', 'superadmin'].includes(effectiveRole()); }

function setPreviewRole(role) {
  if (!canUseViewAs()) return;
  previewRole = role || null;
  const sel = document.getElementById('view-as-select');
  if (sel) sel.value = previewRole || '';
  renderViewAsBanner();
  applyRoleGatedUi();
}

function renderViewAsBanner() {
  const banner = document.getElementById('view-as-banner');
  if (!banner) return;
  if (!previewRole) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
  banner.style.display = 'flex';
  banner.innerHTML = `<span>${t('viewAsBanner', { role: previewRole })}</span><button onclick="setPreviewRole('')">${t('exitPreview')}</button>`;
}

// Re-applies every UI element gated by role (nav tabs, buttons, dynamic list
// rendering) using effectiveRole() instead of the real userRole -- called
// both at startup and whenever the preview role changes.
function applyRoleGatedUi() {
  const isSup = isEffectiveSupervisor();
  document.getElementById('nav-users').style.display = isSup ? 'inline-block' : 'none';
  document.getElementById('btn-close-day').style.display = isSup ? 'inline-block' : 'none';
  const usersTab = document.getElementById('tab-users');
  if (!isSup && usersTab && usersTab.classList.contains('active')) { showTab('monitor'); return; }
  if (document.getElementById('tab-incidents')?.classList.contains('active')) { loadIncidentsList(); loadSessionsTable(); }
  if (usersTab && usersTab.classList.contains('active')) loadQcUsers();
}

// ── Forced password change (temp-password first-login flow) ──
function showForcedPasswordChange() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'none';
  document.getElementById('pwchange-screen').style.display = 'flex';
}

async function submitPasswordChange() {
  const current = document.getElementById('pwchange-current').value;
  const next = document.getElementById('pwchange-new').value;
  const confirmPw = document.getElementById('pwchange-confirm').value;
  const errEl = document.getElementById('pwchange-error');
  if (next !== confirmPw) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
  if (next.length < 10 || !/[a-zA-Z]/.test(next) || !/[0-9]/.test(next)) {
    errEl.textContent = 'Mínimo 10 caracteres, con letras y números.';
    return;
  }
  errEl.textContent = 'Guardando...';
  try {
    const res = await apiCall('POST', '/api/change-password', { currentPassword: current, newPassword: next });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      errEl.textContent = err.error || 'No se pudo guardar la contraseña.';
      return;
    }
    document.getElementById('pwchange-screen').style.display = 'none';
    startApp();
  } catch (e) {
    errEl.textContent = `Error: ${e.message}`;
  }
}

async function apiCall(method, path, body) {
  const opts = { method, headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

// ── Server-synced, frame-accurate timecode ──
// Measured once after login (not continuously -- a one-time offset is
// enough to correct for this PC's clock drift relative to the server, per
// the spec's "reloj del PC corregido con un desfase medido al entrar").
// Uses the HTTP Date header from a plain GET /health round-trip, with a
// crude RTT/2 compensation -- no dedicated time-sync endpoint needed.
let serverTimeOffsetMs = 0;
async function measureServerTimeOffset() {
  try {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/health`, { cache: 'no-store' });
    const t1 = Date.now();
    const dateHeader = res.headers.get('date');
    if (dateHeader) {
      const serverNow = new Date(dateHeader).getTime() + (t1 - t0) / 2;
      serverTimeOffsetMs = serverNow - t1;
    }
  } catch (_) { /* keep offset 0 -- falls back to local time */ }
}
// HH:MM:SS:FF at 25fps, matching the spec's broadcast-timecode convention.
function getCorrectedTimecode() {
  const now = new Date(Date.now() + serverTimeOffsetMs);
  const ff = Math.min(24, Math.floor((now.getMilliseconds() / 1000) * 25));
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:` +
    `${String(now.getSeconds()).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

// ── WS / mediasoup (same signaling protocol as viewer.js) ──
function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: authToken }));
  ws.onclose = () => setTimeout(connect, 3000);
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.requestId && pending.has(msg.requestId)) {
      pending.get(msg.requestId).resolve(msg);
      pending.delete(msg.requestId);
      return;
    }
    handleMessage(msg);
  };
}

function request(type, data = {}) {
  const requestId = ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timeout`)); }, 10000);
    pending.set(requestId, { resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject });
    ws.send(JSON.stringify({ type, requestId, ...data }));
  });
}

let prefsRestored = false;

async function handleMessage(msg) {
  switch (msg.type) {
    case 'auth_ok':
      await setupDevice();
      break;
    case 'auth_error':
      logout();
      break;
    case 'streams':
      lastStreams = msg.streams || [];
      renderFeedPickers();
      // Re-subscribe any grid cell whose producer changed (stream restarted).
      for (const cell of gridCells) {
        if (!cell.streamId) continue;
        const cur = lastStreams.find((s) => s.streamId === cell.streamId);
        if (!cur) { unsubscribeFeed(cell.index); continue; }
        if (cell.producerId && cur.producerId && cur.producerId !== cell.producerId) {
          subscribeToFeed(cell.index, cell.streamId);
        }
      }
      // One-time restore of this device's saved layout/feeds, now that we
      // actually know which streams exist (see point 7, persisted prefs).
      if (!prefsRestored) { prefsRestored = true; restorePrefs(); }
      break;
    case 'qcIncidentAlert':
      addP1Alert(msg.incident);
      break;
  }
}

async function setupDevice() {
  const caps = await request('getRouterRtpCapabilities');
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: caps.rtpCapabilities });
  await request('setRtpCapabilities', { rtpCapabilities: device.rtpCapabilities });
  const tData = await request('createWebRtcTransport');
  transport = device.createRecvTransport({
    id: tData.id,
    iceParameters: tData.iceParameters,
    iceCandidates: tData.iceCandidates,
    dtlsParameters: tData.dtlsParameters,
    iceServers: tData.iceServers,
  });
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    request('connectTransport', { transportId: transport.id, dtlsParameters }).then(() => callback()).catch(errback);
  });
}

// ── Monitor grid ──
// Each cell independently subscribes to a feed (= stream) over the SAME
// recvTransport, without tearing down the other cells' consumers -- the
// same non-exclusive multi-consumer pattern viewer.js already uses for the
// admin's PGM "listen"/cross-monitor features (see consumePgmListenSlot).
const MAX_CELLS = 4;
const gridCells = Array.from({ length: MAX_CELLS }, (_, i) => ({
  index: i, streamId: null, consumers: [], producerId: null,
  vuSourceNode: null, vuSplitterNode: null, vuAnalyserL: null, vuAnalyserR: null,
  // Signal-loss detection (point 5):
  lastFrameCount: undefined, lastFrameCheckedAt: 0, noSignal: false,
  reconnectAttempt: 0, reconnectTimer: null,
}));
let activeCellIndex = 0;
let currentLayout = '1';

// ── Per-feed incoming-audio VU meter (stereo L/R) ──
// Same monitor-only Web Audio tap + segmented-LED rendering technique as
// viewer.js's setupIncomingVuMeter/startVuMeterLoop, one ChannelSplitter +
// L/R analyser pair per grid cell. The main program audio feeds are a
// genuinely 2-channel source (not the mono commentator return mic from the
// Coms app), and the Opus codec now negotiates true stereo (see
// backend/src/mediasoup-config.js + tools/publish.js), so a real L/R split
// is meaningful here. Never connected to any output (purely a level tap),
// so it has zero effect on actual playback.
let qcAudioCtx = null;
function getQcAudioCtx() {
  if (!qcAudioCtx) qcAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (qcAudioCtx.state === 'suspended') qcAudioCtx.resume().catch(() => {});
  return qcAudioCtx;
}
document.addEventListener('click', () => {
  if (qcAudioCtx && qcAudioCtx.state === 'suspended') qcAudioCtx.resume().catch(() => {});
});

function setupCellVuMeter(cellIndex, audioTrack) {
  teardownCellVuMeter(cellIndex);
  if (!audioTrack) return;
  const cell = gridCells[cellIndex];
  try {
    const ctx = getQcAudioCtx();
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    analyserL.fftSize = 512;
    analyserR.fftSize = 512;
    source.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    cell.vuSourceNode = source;
    cell.vuSplitterNode = splitter;
    cell.vuAnalyserL = analyserL;
    cell.vuAnalyserR = analyserR;
  } catch (err) {
    console.warn(`No se pudo iniciar el v\u00fametro del feed ${cellIndex}:`, err);
  }
}

function teardownCellVuMeter(cellIndex) {
  const cell = gridCells[cellIndex];
  try { cell.vuSourceNode?.disconnect(); } catch (_) {}
  try { cell.vuSplitterNode?.disconnect(); } catch (_) {}
  cell.vuSourceNode = null;
  cell.vuSplitterNode = null;
  cell.vuAnalyserL = null;
  cell.vuAnalyserR = null;
}

const VU_MIN_DB = -50; // treated as 0% (near silence/room noise)
const VU_MAX_DB = -8;  // treated as 100% (hot but pre-clipping)
const VU_SEGMENT_COUNT = 8;

function vuRms(analyser, buf) {
  analyser.getByteTimeDomainData(buf);
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / buf.length);
}

function vuLevelPercent(analyser, buf) {
  const rms = vuRms(analyser, buf);
  if (rms <= 0.0001) return 0; // avoid -Infinity dB for true silence
  const db = 20 * Math.log10(rms);
  const pct = ((db - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB)) * 100;
  return Math.max(0, Math.min(100, pct));
}

// Lazily builds the fixed stack of <div class="vu-segment"> children for a
// meter container and caches the resulting element list on the container
// itself -- same pattern as viewer.js's getVuSegments.
function getVuSegments(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  if (!el._vuSegments) {
    const frag = document.createDocumentFragment();
    const segments = [];
    for (let i = 0; i < VU_SEGMENT_COUNT; i++) {
      const seg = document.createElement('div');
      seg.className = 'vu-segment';
      frag.appendChild(seg);
      segments.push(seg);
    }
    el.appendChild(frag);
    el._vuSegments = segments;
  }
  return el._vuSegments;
}

function renderSegmentedMeter(segments, pct) {
  const total = segments.length;
  const litCount = Math.round((pct / 100) * total);
  for (let i = 0; i < total; i++) {
    const seg = segments[i];
    seg.classList.remove('lit-green', 'lit-orange', 'lit-red');
    if (i < litCount) {
      const posPct = ((i + 1) / total) * 100;
      seg.classList.add(posPct > 80 ? 'lit-red' : posPct > 60 ? 'lit-orange' : 'lit-green');
    }
  }
}

function startVuMeterLoop() {
  const bufsL = gridCells.map(() => new Uint8Array(512));
  const bufsR = gridCells.map(() => new Uint8Array(512));
  function frame() {
    gridCells.forEach((cell, i) => {
      const segmentsL = getVuSegments(`feed-vu-${i}-l`);
      const segmentsR = getVuSegments(`feed-vu-${i}-r`);
      if (segmentsL.length) renderSegmentedMeter(segmentsL, cell.vuAnalyserL ? vuLevelPercent(cell.vuAnalyserL, bufsL[i]) : 0);
      if (segmentsR.length) renderSegmentedMeter(segmentsR, cell.vuAnalyserR ? vuLevelPercent(cell.vuAnalyserR, bufsR[i]) : 0);
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
startVuMeterLoop();

// ── Grid layout, including the "1 grande + 3 pequeños" mosaic ──
function setGridLayout(layout) {
  currentLayout = layout;
  const grid = document.getElementById('monitor-grid');
  grid.className = `monitor-grid layout-${layout}`;
  const visibleCount = layout === '1' ? 1 : layout === '2x1' ? 2 : 4; // '2x2' and '1-3' both show 4
  document.querySelectorAll('.feed-cell').forEach((el, i) => {
    el.style.display = i < visibleCount ? 'flex' : 'none';
    if (i >= visibleCount && gridCells[i].streamId) unsubscribeFeed(i);
    if (layout !== '1-3') el.removeAttribute('data-pos');
  });
  if (layout === '1-3') applyMosaicPositions();
  savePrefs();
}

// Assigns each visible cell a grid-area slot (big/small1/small2/small3) for
// the "1+3" mosaic layout, based on whichever cell is currently ACTIVE --
// clicking a small cell moves it to "big" purely via this CSS-area
// reassignment, WITHOUT touching its mediasoup consumers/video element at
// all (see the spec's "sin reiniciar su conexión").
function applyMosaicPositions() {
  if (currentLayout !== '1-3') return;
  const order = ['big', 'small1', 'small2', 'small3'];
  const seq = [activeCellIndex, ...[0, 1, 2, 3].filter((i) => i !== activeCellIndex)];
  seq.forEach((cellIndex, posIdx) => {
    const el = document.getElementById(`feed-cell-${cellIndex}`);
    if (el) el.dataset.pos = order[posIdx];
  });
}

function renderFeedPickers() {
  document.querySelectorAll('.feed-picker').forEach((select) => {
    const cellIndex = parseInt(select.dataset.cell);
    const current = gridCells[cellIndex].streamId;
    select.innerHTML = `<option value="">${t('feedPickerPlaceholder')}</option>` + lastStreams.map((s) =>
      `<option value="${s.streamId}" ${s.streamId === current ? 'selected' : ''}>${s.streamName || s.streamId}</option>`
    ).join('');
  });
  renderSessionBadges();
}

async function onFeedPicked(cellIndex, streamId) {
  if (!streamId) { unsubscribeFeed(cellIndex); savePrefs(); return; }
  await subscribeToFeed(cellIndex, streamId);
}

async function subscribeToFeed(cellIndex, streamId) {
  if (!transport) return;
  unsubscribeFeed(cellIndex, /* keepPicker */ true);
  const cell = gridCells[cellIndex];
  cell.streamId = streamId;
  const stream = lastStreams.find((s) => s.streamId === streamId);
  cell.producerId = stream?.producerId || null;
  try {
    const sub = await request('subscribe', { streamId });
    const consumerList = sub.consumers || [sub];
    const tracks = [];
    for (const cd of consumerList) {
      const consumer = await transport.consume({ id: cd.id, producerId: cd.producerId, kind: cd.kind, rtpParameters: cd.rtpParameters });
      cell.consumers.push(consumer);
      tracks.push(consumer.track);
      await request('resumeConsumer', { consumerId: consumer.id });
    }
    const video = document.getElementById(`feed-video-${cellIndex}`);
    video.srcObject = new MediaStream(tracks);
    // Exclusive audio (point: "feed activo con audio, resto en silencio"):
    // only the ACTIVE cell plays audio; everything else stays muted.
    video.muted = (cellIndex !== activeCellIndex);
    video.play().catch(() => {});
    setupCellVuMeter(cellIndex, tracks.find((t) => t.kind === 'audio'));
    document.getElementById(`feed-label-${cellIndex}`).textContent = stream?.streamName || streamId;
    updateMuteIcon(cellIndex);
    cell.lastFrameCount = undefined;
    cell.lastFrameCheckedAt = Date.now();
    clearNoSignal(cellIndex);
    renderSessionBadges();
    savePrefs();
  } catch (err) {
    console.error(`No se pudo suscribir al feed ${streamId}:`, err);
  }
}

function unsubscribeFeed(cellIndex, keepPicker) {
  const cell = gridCells[cellIndex];
  for (const c of cell.consumers) { try { c.close(); } catch (_) {} }
  cell.consumers = [];
  cell.streamId = null;
  cell.producerId = null;
  teardownCellVuMeter(cellIndex);
  clearNoSignal(cellIndex);
  const video = document.getElementById(`feed-video-${cellIndex}`);
  if (video) { video.srcObject = null; }
  const label = document.getElementById(`feed-label-${cellIndex}`);
  if (label) label.textContent = '';
  if (!keepPicker) {
    const picker = document.querySelector(`.feed-picker[data-cell="${cellIndex}"]`);
    if (picker) picker.value = '';
  }
}

function updateMuteIcon(cellIndex) {
  const video = document.getElementById(`feed-video-${cellIndex}`);
  const btn = document.getElementById(`feed-mute-${cellIndex}`);
  if (video && btn) btn.textContent = video.muted ? '🔇' : '🔊';
}

// Manual override: still available even though the active cell auto-
// unmutes/mutes on selection (see setActiveCell) -- e.g. to quickly mute
// the active feed without switching away from it.
function toggleCellAudio(cellIndex) {
  const video = document.getElementById(`feed-video-${cellIndex}`);
  if (!video) return;
  video.muted = !video.muted;
  updateMuteIcon(cellIndex);
}

// Selecting a feed as "active" (click on its cell) does two things beyond
// just highlighting it: (1) exclusive audio -- that feed unmutes, every
// other cell mutes; (2) in the "1+3" mosaic layout, it becomes the big
// cell, purely via CSS grid-area reassignment (applyMosaicPositions),
// WITHOUT touching any mediasoup consumer/video element.
function setActiveCell(cellIndex) {
  activeCellIndex = cellIndex;
  document.querySelectorAll('.feed-cell').forEach((el, i) => el.classList.toggle('active-feed', i === cellIndex));
  gridCells.forEach((cell, i) => {
    const video = document.getElementById(`feed-video-${i}`);
    if (!video) return;
    video.muted = (i !== cellIndex);
    updateMuteIcon(i);
  });
  applyMosaicPositions();
  renderActiveFeedBar();
  savePrefs();
}

function getActiveStreamId() {
  return gridCells[activeCellIndex]?.streamId || null;
}

// ── Per-feed fullscreen (point 4) ──
// Button + double-click both call this; exiting uses the SAME gesture
// (double-click again) or the browser-native Esc (handled automatically by
// the Fullscreen API, no extra code needed for that part).
function toggleCellFullscreen(cellIndex) {
  const el = document.getElementById(`feed-cell-${cellIndex}`);
  if (!el) return;
  if (document.fullscreenElement === el) document.exitFullscreen();
  else el.requestFullscreen().catch(() => {});
}
document.addEventListener('fullscreenchange', () => {
  document.querySelectorAll('.feed-cell').forEach((el) => el.classList.toggle('cell-fullscreen', document.fullscreenElement === el));
});

// ── "Sin señal" detection + auto-reconnect with growing backoff (point 5) ──
// Polls each subscribed cell's video consumer stats for framesDecoded; if
// it hasn't advanced in ~5s, shows the SIN SEÑAL overlay and starts
// retrying subscribeToFeed() with backoff 2/4/8/15s (capped), without ever
// dropping the feed from its cell -- it just keeps retrying until frames
// resume, at which point the next stats poll clears the overlay.
const STATS_POLL_MS = 1500;
const NO_SIGNAL_THRESHOLD_MS = 5000;
const RECONNECT_BACKOFFS_MS = [2000, 4000, 8000, 15000];

function markNoSignal(cellIndex) {
  const cell = gridCells[cellIndex];
  if (cell.noSignal) return;
  cell.noSignal = true;
  const overlay = document.getElementById(`feed-nosignal-${cellIndex}`);
  if (overlay) overlay.style.display = 'flex';
  cell.reconnectAttempt = 0;
  scheduleReconnect(cellIndex);
}

function clearNoSignal(cellIndex) {
  const cell = gridCells[cellIndex];
  cell.noSignal = false;
  cell.reconnectAttempt = 0;
  if (cell.reconnectTimer) { clearTimeout(cell.reconnectTimer); cell.reconnectTimer = null; }
  const overlay = document.getElementById(`feed-nosignal-${cellIndex}`);
  if (overlay) overlay.style.display = 'none';
}

function scheduleReconnect(cellIndex) {
  const cell = gridCells[cellIndex];
  const delay = RECONNECT_BACKOFFS_MS[Math.min(cell.reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1)];
  cell.reconnectAttempt++;
  clearTimeout(cell.reconnectTimer);
  cell.reconnectTimer = setTimeout(async () => {
    if (!cell.noSignal || !cell.streamId) return; // recovered or unsubscribed meanwhile
    await subscribeToFeed(cellIndex, cell.streamId);
    // subscribeToFeed() calls clearNoSignal() on success, but frames may
    // not have actually resumed yet (still the same stale source) -- keep
    // the overlay/backoff going until the NEXT stats poll confirms real
    // frame movement; re-mark here so the retry loop continues.
    if (!gridCells[cellIndex].noSignal) markNoSignal(cellIndex);
    else scheduleReconnect(cellIndex);
  }, delay);
}

function startStatsPolling() {
  setInterval(async () => {
    for (const cell of gridCells) {
      if (!cell.streamId) continue;
      const videoConsumer = cell.consumers.find((c) => c.track && c.track.kind === 'video');
      if (!videoConsumer) continue;
      try {
        const stats = await videoConsumer.getStats();
        let framesDecoded = null;
        stats.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') framesDecoded = r.framesDecoded; });
        if (framesDecoded === null) continue;
        const now = Date.now();
        if (cell.lastFrameCount === undefined || framesDecoded !== cell.lastFrameCount) {
          cell.lastFrameCount = framesDecoded;
          cell.lastFrameCheckedAt = now;
          if (cell.noSignal) clearNoSignal(cell.index);
        } else if (now - (cell.lastFrameCheckedAt || now) > NO_SIGNAL_THRESHOLD_MS) {
          markNoSignal(cell.index);
        }
      } catch (_) { /* consumer may have just closed mid-poll -- ignore */ }
    }
  }, STATS_POLL_MS);
}
startStatsPolling();

// ── Persisted per-device preferences (point 7) ──
// Which layout + which feed is picked in each grid cell, saved locally so
// this specific device/browser remembers them across reloads -- explicitly
// NOT synced server-side (each auditor's workstation keeps its own).
function savePrefs() {
  try {
    localStorage.setItem('qc-monitor-prefs', JSON.stringify({
      layout: currentLayout,
      feeds: gridCells.map((c) => c.streamId),
    }));
  } catch (_) {}
}

function restorePrefs() {
  let prefs;
  try { prefs = JSON.parse(localStorage.getItem('qc-monitor-prefs') || 'null'); } catch (_) { prefs = null; }
  if (!prefs) return;
  if (prefs.layout) setGridLayout(prefs.layout);
  if (Array.isArray(prefs.feeds)) {
    prefs.feeds.forEach((streamId, i) => {
      if (streamId && lastStreams.some((s) => s.streamId === streamId)) subscribeToFeed(i, streamId);
    });
  }
}

// ── Sessions (open/close per feed) ──
let sessionsByStream = {}; // streamId -> open session object

async function refreshOpenSessions() {
  const res = await apiCall('GET', '/api/qc/sessions?status=open');
  if (!res.ok) return;
  const sessions = await res.json();
  sessionsByStream = {};
  for (const s of sessions) sessionsByStream[s.stream_id] = s;
  renderSessionBadges();
  renderActiveFeedBar();
}

// Per-feed incident counter + unresolved-P1 badge (#20) -- incident_count/
// open_p1_count come straight from db.getSessions()'s correlated subqueries
// (see backend/src/services/database.js), so no extra round-trip is needed
// here beyond the existing refreshOpenSessions() polling.
function renderSessionBadges() {
  gridCells.forEach((cell, i) => {
    const badge = document.getElementById(`feed-session-${i}`);
    if (!badge) return;
    const session = cell.streamId ? sessionsByStream[cell.streamId] : null;
    if (!session) {
      badge.textContent = cell.streamId ? t('noOpenSession') : '';
      badge.className = 'feed-session-badge';
      return;
    }
    const countPart = session.incident_count ? ` · ${session.incident_count}` : '';
    const p1Part = session.open_p1_count ? ` <span class="feed-p1-badge">P1 ×${session.open_p1_count}</span>` : '';
    badge.innerHTML = `${t('sessionOpenBadge')}${countPart}${p1Part}`;
    badge.className = 'feed-session-badge open';
  });
}

function renderActiveFeedBar() {
  const streamId = getActiveStreamId();
  const bar = document.getElementById('active-feed-bar');
  if (!bar) return;
  if (!streamId) { bar.textContent = t('noActiveFeedHint'); return; }
  const stream = lastStreams.find((s) => s.streamId === streamId);
  const session = sessionsByStream[streamId];
  bar.innerHTML = `
    <strong>${t('activeFeedLabel')}</strong> ${stream?.streamName || streamId}
    ${session
      ? `<span class="session-open">${t('sessionOpenBadge')}</span>
         <button onclick="closeSessionForActive()">${t('closeSessionBtn')}</button>
         <button onclick="markIncident()" class="btn-mark">${t('mark')}</button>`
      : `<button onclick="openSessionForActive()">${t('openSessionBtn')}</button>`}
  `;
}

async function openSessionForActive() {
  const streamId = getActiveStreamId();
  if (!streamId) return;
  const stream = lastStreams.find((s) => s.streamId === streamId);
  const res = await apiCall('POST', '/api/qc/sessions', { streamId, streamName: stream?.streamName || streamId });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || t('noSessionOpenAlert'));
    return;
  }
  await refreshOpenSessions();
}

async function closeSessionForActive() {
  const streamId = getActiveStreamId();
  const session = streamId && sessionsByStream[streamId];
  if (!session) return;
  if (!confirm(t('confirmCloseSession'))) return;
  await apiCall('POST', `/api/qc/sessions/${session.id}/close`);
  await refreshOpenSessions();
}

async function closeTheDay() {
  if (!confirm(t('confirmCloseDay'))) return;
  const res = await apiCall('POST', '/api/qc/sessions/close-day');
  if (res.ok) {
    await refreshOpenSessions();
    if (confirm(t('askDayReport'))) openDayReport();
  }
}

// ── Incidents: quick-mark (M) + describe-later + status/void ──
function isTypingInField() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// Guards against the browser's own key-repeat (holding M down) firing many
// marks in a row -- only reacts to the FIRST keydown of a press (e.repeat),
// and additionally ignores the key entirely until keyup, closing any gap a
// given browser's `repeat` flag might not cover.
let markKeyDown = false;
document.addEventListener('keydown', (e) => {
  if (isTypingInField()) return;
  if ((e.key === 'm' || e.key === 'M')) {
    if (e.repeat || markKeyDown) return;
    markKeyDown = true;
    markIncident();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'm' || e.key === 'M') markKeyDown = false;
});

async function markIncident() {
  const streamId = getActiveStreamId();
  if (!streamId) { alert(t('noActiveFeedAlert')); return; }
  const session = sessionsByStream[streamId];
  if (!session) { alert(t('noSessionAlert')); return; }
  const stream = lastStreams.find((s) => s.streamId === streamId);
  const timecode = getCorrectedTimecode();
  // Captured AT THE INSTANT of marking (not when later described) -- the
  // exact frame is what matters, even if the description comes much later.
  const snapshot = captureSnapshotFor(activeCellIndex);
  const res = await apiCall('POST', '/api/qc/incidents/mark', {
    streamId, streamName: stream?.streamName || streamId, timecode, sessionId: session.id, snapshot,
  });
  if (!res.ok) { alert(t('markFailedAlert')); return; }
  flashMarked();
  refreshPendingCount();
  if (document.getElementById('tab-incidents').classList.contains('active')) loadIncidentsList();
}

function flashMarked() {
  const bar = document.getElementById('active-feed-bar');
  bar.classList.add('flash');
  setTimeout(() => bar.classList.remove('flash'), 400);
}

async function refreshPendingCount() {
  const res = await apiCall('GET', '/api/qc/incidents?pending=1');
  if (!res.ok) return;
  const list = await res.json();
  const badge = document.getElementById('pending-badge');
  badge.textContent = list.length;
  badge.style.display = list.length ? 'inline-block' : 'none';
}

// Incidents tab -- categories stored as language-neutral CODES (never
// display text), matching the spec's "estados y categorías guardados como
// códigos y no como texto" requirement, so switching language never
// requires touching stored data.
const INCIDENT_CATEGORIES = [
  { code: 'audio', key: 'catAudio' },
  { code: 'direction', key: 'catDirection' },
  { code: 'graphics', key: 'catGraphics' },
  { code: 'narrative', key: 'catNarrative' },
  { code: 'replays', key: 'catReplays' },
  { code: 'client_rules', key: 'catRules' },
];
function categoryLabel(code) {
  const found = INCIDENT_CATEGORIES.find((c) => c.code === code);
  return found ? t(found.key) : (code || '');
}
const STATUS_KEYS = { open: 'statusOpen', in_review: 'stInAnalysis', notified: 'stNotified', resolved: 'stResolved' };
function statusLabel(status) { return t(STATUS_KEYS[status] || status); }
const SEVERITY_KEYS = { P1: 'sevP1', P2: 'sevP2', P3: 'sevP3' };
function severityLabel(sev) { return t(SEVERITY_KEYS[sev] || sev); }

let incidentsFilter = { status: '', includeVoided: false, pendingOnly: false, severity: '', operatorUsername: '' };
let lastIncidentsList = []; // populated by loadIncidentsList(), looked up by openDescribeModal() for #31's clip button

function setIncidentsFilter(patch) {
  Object.assign(incidentsFilter, patch);
  loadIncidentsList();
}

function buildIncidentsParams(filter) {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.includeVoided) params.set('includeVoided', '1');
  if (filter.pendingOnly) params.set('pending', '1');
  if (filter.severity) params.set('severity', filter.severity);
  if (filter.operatorUsername) params.set('operatorUsername', filter.operatorUsername);
  return params;
}

async function loadIncidentsList() {
  const res = await apiCall('GET', `/api/qc/incidents?${buildIncidentsParams(incidentsFilter).toString()}`);
  if (!res.ok) return;
  const incidents = await res.json();
  lastIncidentsList = incidents;
  renderIncidentsList(incidents);
  refreshPendingCount();
  updateOperatorFilterOptions();
}

// Populates the auditor/operator filter dropdown (#20) from the operators
// actually present under the OTHER currently active filters -- queried
// separately (without operatorUsername) so narrowing by operator doesn't
// also shrink the list of choices on its own next render.
async function updateOperatorFilterOptions() {
  const select = document.getElementById('operator-filter');
  if (!select) return;
  const res = await apiCall('GET', `/api/qc/incidents?${buildIncidentsParams({ ...incidentsFilter, operatorUsername: '' }).toString()}`);
  if (!res.ok) return;
  const incidents = await res.json();
  const operators = Array.from(new Set(incidents.map((i) => i.operator_username))).sort();
  const current = incidentsFilter.operatorUsername;
  select.innerHTML = `<option value="">${t('operatorAll')}</option>` +
    operators.map((op) => `<option value="${op}" ${op === current ? 'selected' : ''}>${op}</option>`).join('');
}

function renderIncidentsList(incidents) {
  const list = document.getElementById('incidents-list');
  if (!incidents.length) {
    list.innerHTML = `<div class="empty-hint">${t('noIncidentsYet')}</div>`;
    return;
  }
  const isSupervisor = isEffectiveSupervisor();
  list.innerHTML = incidents.map((inc) => {
    const voided = !!inc.void_reason;
    const mine = inc.operator_username === currentUsername;
    return `
    <div class="incident-item ${inc.severity} ${voided ? 'voided' : ''} ${inc.pending ? 'pending' : ''}">
      <div class="incident-body">
        <div class="incident-top">
          <span class="incident-sev-badge ${inc.severity}">${inc.severity}</span>
          <strong>${inc.stream_name}</strong>
          <span class="incident-status">${statusLabel(inc.status)}</span>
          ${inc.pending ? `<span class="pending-tag">${t('pendingTag')}</span>` : ''}
          ${voided ? `<span class="voided-tag">${t('voidedTag')}</span>` : ''}
        </div>
        ${inc.category ? `<div class="incident-cat">${categoryLabel(inc.category)}</div>` : ''}
        <div class="incident-desc">${inc.description || `<em>${t('noDescription')}</em>`}</div>
        <div class="incident-meta">
          ${inc.timecode || ''} · ${inc.operator_username} (${inc.operator_role}) · ${inc.created_at}
          ${voided ? `<br>${t('voidedByLabel')} ${inc.voided_by}: ${inc.void_reason}` : ''}
        </div>
        <div class="incident-actions">
          ${inc.pending ? `<button onclick="openDescribeModal(${inc.id})">${t('describeBtn')}</button>` : ''}
          ${!inc.pending && !voided && (mine || isSupervisor) ? `<button onclick="openDescribeModal(${inc.id})">${t('editBtn')}</button>` : ''}
          ${!voided && (mine || isSupervisor) ? `
            <select onchange="setIncidentStatus(${inc.id}, this.value)">
              ${Object.keys(STATUS_KEYS).map((k) => `<option value="${k}" ${inc.status === k ? 'selected' : ''}>${statusLabel(k)}</option>`).join('')}
            </select>
            <button onclick="voidIncidentPrompt(${inc.id})">${t('voidBtn')}</button>` : ''}
          ${(inc.pending && (mine || isSupervisor)) || (voided && isSupervisor)
            ? `<button class="btn-danger" onclick="deleteIncidentById(${inc.id})">${t('deleteBtn')}</button>` : ''}
          ${inc.clip_path ? `<button onclick="playIncidentClip(${inc.id})" style="background:#666; color:#fff;">▶ ${t('clipBtn')}</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

async function setIncidentStatus(id, status) {
  await apiCall('PUT', `/api/qc/incidents/${id}/status`, { status });
  loadIncidentsList();
}

async function voidIncidentPrompt(id) {
  const reason = prompt(t('voidReasonPrompt'));
  if (!reason) return;
  await apiCall('PUT', `/api/qc/incidents/${id}/void`, { reason });
  loadIncidentsList();
}

async function deleteIncidentById(id) {
  if (!confirm(t('confirmDeleteIncident'))) return;
  const res = await apiCall('DELETE', `/api/qc/incidents/${id}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || t('deleteFailedAlert'));
    return;
  }
  loadIncidentsList();
}

// Describe modal (fills in category/severity/description for a pending or
// existing incident). Preloads whatever snapshot ALREADY exists (captured
// at mark-time, see markIncident()) via the authenticated snapshot route,
// instead of starting blank -- "Capturar snapshot" lets the operator
// explicitly grab a fresher one if they want to override it.
let describeIncidentId = null;
async function openDescribeModal(id) {
  describeIncidentId = id;
  document.getElementById('describe-category').innerHTML = INCIDENT_CATEGORIES.map((c) => `<option value="${c.code}">${t(c.key)}</option>`).join('');
  document.getElementById('describe-severity').value = 'P2';
  document.getElementById('describe-desc').value = '';
  const preview = document.getElementById('describe-snapshot-preview');
  preview.removeAttribute('data-fresh');
  preview.src = '';
  try {
    const res = await apiCall('GET', `/api/qc/incidents/${id}/snapshot`);
    if (res.ok) preview.src = URL.createObjectURL(await res.blob());
  } catch (_) {}
  // #31: show a "Clip" button if this incident already has one extracted
  // (see clip-recorder.js) -- looked up from the already-loaded list rather
  // than a dedicated GET-by-id route, which doesn't exist.
  const clipWrap = document.getElementById('describe-clip-btn-wrap');
  const incident = lastIncidentsList.find((i) => i.id === id);
  clipWrap.innerHTML = incident?.clip_path
    ? `<button onclick="playIncidentClip(${id})" style="background:#666; color:#fff;">▶ ${t('clipBtn')}</button>` : '';
  document.getElementById('describe-modal-overlay').classList.add('active');
}

// #31: fetches the incident's 10s clip as an authenticated blob (the <video>
// element itself can't carry an Authorization header) and plays it in a
// small dedicated modal.
async function playIncidentClip(id) {
  const res = await apiCall('GET', `/api/qc/incidents/${id}/clip`);
  if (!res.ok) { alert(t('clipNotReady')); return; }
  const player = document.getElementById('clip-player');
  player.src = URL.createObjectURL(await res.blob());
  document.getElementById('clip-modal-overlay').classList.add('active');
  player.play().catch(() => {});
}

function closeClipModal() {
  const player = document.getElementById('clip-player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  document.getElementById('clip-modal-overlay').classList.remove('active');
}

function closeDescribeModal() {
  document.getElementById('describe-modal-overlay').classList.remove('active');
  describeIncidentId = null;
}

function captureSnapshotFor(cellIndex) {
  const video = document.getElementById(`feed-video-${cellIndex}`);
  if (!video || !video.videoWidth) return '';
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function captureSnapshotForDescribe() {
  const dataUrl = captureSnapshotFor(activeCellIndex);
  const preview = document.getElementById('describe-snapshot-preview');
  if (dataUrl) { preview.src = dataUrl; preview.dataset.fresh = '1'; }
  return dataUrl;
}

async function submitDescribe() {
  const category = document.getElementById('describe-category').value;
  const severity = document.getElementById('describe-severity').value;
  const description = document.getElementById('describe-desc').value.trim();
  if (!description) { alert(t('describeRequired')); return; }
  const preview = document.getElementById('describe-snapshot-preview');
  // Only send a NEW snapshot if the operator explicitly re-captured one via
  // captureSnapshotForDescribe() (dataset.fresh) -- otherwise leave it out
  // so the server's COALESCE keeps the mark-time snapshot already on file.
  const snapshot = preview.dataset.fresh === '1' ? preview.src : undefined;
  const res = await apiCall('PUT', `/api/qc/incidents/${describeIncidentId}/describe`, { category, severity, description, snapshot });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || t('saveFailedAlert'));
    return;
  }
  closeDescribeModal();
  loadIncidentsList();
}

// ── P1 on-screen/sound alert (urgent #1) ──
// Live-pushed only (see the WS 'qcIncidentAlert' case in handleMessage) --
// never derived from historical/REST data, so a client that (re)connects
// later never alerts on P1s that already existed before it was watching.
const p1Alerts = new Map(); // incident id -> incident summary
let p1SoundTimer = null;

function addP1Alert(incident) {
  p1Alerts.set(incident.id, incident);
  renderP1Banner();
  document.body.classList.add('p1-alert-active');
  startP1Sound();
}

async function ackP1Alert(id) {
  try { await apiCall('PUT', `/api/qc/incidents/${id}/ack`); } catch (_) {}
  p1Alerts.delete(id);
  renderP1Banner();
  if (p1Alerts.size === 0) {
    document.body.classList.remove('p1-alert-active');
    stopP1Sound();
  }
}

function renderP1Banner() {
  const banner = document.getElementById('p1-alert-banner');
  if (!banner) return;
  if (p1Alerts.size === 0) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
  banner.style.display = 'flex';
  banner.innerHTML = Array.from(p1Alerts.values()).map((inc) => `
    <div class="p1-alert-item">
      <strong>P1</strong> · ${inc.streamName} · ${categoryLabel(inc.category)} · ${inc.description || ''}
      <button onclick="ackP1Alert(${inc.id})">🔔 ${t('alertAck')}</button>
    </div>`).join('');
}

// Two short beeps (see the spec's "doble pitido"), repeated every 8s until
// every current P1 is acknowledged.
function beepPair() {
  try {
    const ctx = getQcAudioCtx();
    [0, 220].forEach((delay) => {
      setTimeout(() => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.value = 0.18;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        setTimeout(() => { try { osc.stop(); } catch (_) {} }, 150);
      }, delay);
    });
  } catch (_) {}
}

function startP1Sound() {
  if (p1SoundTimer) return;
  beepPair();
  p1SoundTimer = setInterval(() => {
    if (p1Alerts.size > 0) beepPair(); else stopP1Sound();
  }, 8000);
}

function stopP1Sound() {
  if (p1SoundTimer) { clearInterval(p1SoundTimer); p1SoundTimer = null; }
}

// ── Reports (session + day), CSV export + print-to-PDF ──
async function downloadCsv(path, filename) {
  const res = await apiCall('GET', path);
  if (!res.ok) { alert(t('exportFailedAlert')); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function openDayReport() {
  const res = await apiCall('GET', '/api/qc/reports/day');
  if (!res.ok) return;
  const report = await res.json();
  renderReportOverlay(report, `/api/qc/reports/day/export.csv`, `qc_day_${report.date}.csv`, `${t('dayReportTitle')} — ${report.date}`);
}

async function openSessionReport(sessionId) {
  const res = await apiCall('GET', `/api/qc/reports/session/${sessionId}`);
  if (!res.ok) return;
  const report = await res.json();
  renderReportOverlay(
    { date: report.session.stream_name, sessions: [report.session], incidents: report.incidents, summary: report.summary },
    `/api/qc/reports/session/${sessionId}/export.csv`, `qc_session_${sessionId}.csv`,
    `${t('sessionReportTitle')} — ${report.session.stream_name}`,
    report.session.id
  );
}

// Reports only ever receive non-voided, non-pending incidents from the
// server now (see index.js's report routes) -- nothing to filter here.
// `editableSessionId` is set only for a single-SESSION report (#22): shows
// an editable exec-summary/recommendations pair wired to PUT
// .../sessions/:id/notes. The consolidated DAY report instead shows each
// session's already-saved notes read-only, inline in the sessions list.
function renderReportOverlay(report, csvPath, csvName, title, editableSessionId) {
  const overlay = document.getElementById('report-overlay');
  const body = document.getElementById('report-body');
  const chronological = report.incidents.slice().sort((a, b) => a.id - b.id);
  const sessionsListHtml = report.sessions.map((s) => `
    <li>
      ${s.stream_name}${s.name ? ` — ${s.name}` : ''} (${s.status === 'open' ? t('sessionOpenState') : t('sessionClosedState')})
      ${!editableSessionId && (s.exec_summary || s.recommendations) ? `
        <div class="session-notes-ro">
          ${s.exec_summary ? `<div><strong>${t('execSummaryLabel')}:</strong> ${s.exec_summary}</div>` : ''}
          ${s.recommendations ? `<div><strong>${t('recommendationsLabel')}:</strong> ${s.recommendations}</div>` : ''}
        </div>` : ''}
    </li>`).join('');
  const notesEditorHtml = editableSessionId ? `
    <h3>${t('execSummaryLabel')}</h3>
    <textarea id="report-exec-summary" placeholder="${t('execSummaryPlaceholder')}">${report.sessions[0]?.exec_summary || ''}</textarea>
    <h3>${t('recommendationsLabel')}</h3>
    <textarea id="report-recommendations" placeholder="${t('recommendationsPlaceholder')}">${report.sessions[0]?.recommendations || ''}</textarea>
    <div class="modal-actions" style="justify-content:flex-start;">
      <button onclick="saveSessionNotes(${editableSessionId})">${t('saveNotes')}</button>
      <span id="report-notes-saved" style="font-size:12px; color:#00e676; display:none;">${t('saved')}</span>
    </div>` : '';
  body.innerHTML = `
    <h2>${title}</h2>
    <div class="report-summary">
      <div>${t('reportTotal')} <strong>${report.summary.total}</strong></div>
      <div>P1: ${report.summary.bySeverity.P1 || 0} · P2: ${report.summary.bySeverity.P2 || 0} · P3: ${report.summary.bySeverity.P3 || 0}</div>
    </div>
    <h3>${t('reportSessionsTitle')}</h3>
    <ul>${sessionsListHtml}</ul>
    ${notesEditorHtml}
    <h3>${t('reportChronological')}</h3>
    <table class="report-table">
      <thead><tr><th>${t('colTime')}</th><th>${t('colFeed')}</th><th>${t('colCategory')}</th><th>${t('colSeverity')}</th><th>${t('colStatus')}</th><th>${t('colDescription')}</th><th>${t('colOperator')}</th></tr></thead>
      <tbody>${chronological.map((i) => `
        <tr>
          <td>${i.timecode || ''}</td><td>${i.stream_name}</td><td>${categoryLabel(i.category)}</td>
          <td>${severityLabel(i.severity)}</td><td>${statusLabel(i.status)}</td>
          <td>${i.description || ''}</td><td>${i.operator_username}</td>
        </tr>`).join('')}</tbody>
    </table>
  `;
  document.getElementById('report-export-csv').onclick = () => downloadCsv(csvPath, csvName);
  overlay.classList.add('active');
}

// #22: saves the editable exec summary/recommendations for a single-session
// report. qcWrite-scoped on the server (coordinator/supervisor/engineer).
async function saveSessionNotes(sessionId) {
  const execSummary = document.getElementById('report-exec-summary').value;
  const recommendations = document.getElementById('report-recommendations').value;
  const res = await apiCall('PUT', `/api/qc/sessions/${sessionId}/notes`, { execSummary, recommendations });
  if (!res.ok) { alert(t('saveFailedAlert')); return; }
  const savedEl = document.getElementById('report-notes-saved');
  if (savedEl) {
    savedEl.style.display = 'inline';
    setTimeout(() => { savedEl.style.display = 'none'; }, 2000);
  }
}

function closeReportOverlay() {
  document.getElementById('report-overlay').classList.remove('active');
}

function printReport() {
  window.print();
}

// ── Sessions-by-feed table (within the Incidents tab) ──
async function loadSessionsTable() {
  const includeClosed = document.getElementById('sessions-show-archive').checked;
  const res = await apiCall('GET', includeClosed ? '/api/qc/sessions' : '/api/qc/sessions?status=open');
  if (!res.ok) return;
  const sessions = await res.json();
  const list = document.getElementById('sessions-table');
  if (!sessions.length) { list.innerHTML = `<div class="empty-hint">${t('noSessionsYet')}</div>`; return; }
  const isSupervisor = isEffectiveSupervisor();
  list.innerHTML = `
    <table class="report-table">
      <thead><tr><th>${t('colFeed')}</th><th>${t('colSession')}</th><th>${t('colStatus')}</th><th>${t('colOpenedBy')}</th><th>${t('colActions')}</th></tr></thead>
      <tbody>${sessions.map((s) => `
        <tr>
          <td>${s.stream_name}</td><td>${s.name || '—'}</td>
          <td>${s.status === 'open' ? t('sessionOpenState') : t('sessionClosedState')}</td>
          <td>${s.opened_by}</td>
          <td>
            <button onclick="openSessionReport(${s.id})">${t('reportBtn')}</button>
            ${isSupervisor ? `<button class="btn-danger" onclick="deleteSessionById(${s.id})">${t('deleteSessionBtn')}</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
    </table>`;
}

async function deleteSessionById(id) {
  if (!confirm(t('confirmDeleteSession'))) return;
  await apiCall('DELETE', `/api/qc/sessions/${id}`);
  loadSessionsTable();
  refreshOpenSessions();
}

// ── Users tab (qc_supervisor+) ──
async function loadQcUsers() {
  const res = await apiCall('GET', '/api/qc/users');
  if (!res.ok) return;
  const users = await res.json();
  const list = document.getElementById('qc-users-list');
  list.innerHTML = users.map((u) => `
    <div class="qc-user-row">
      <span class="qc-user-name">${u.username}</span>
      <select onchange="changeQcUserRole(${u.id}, this.value)">
        ${['qc_coordinator', 'qc_supervisor', 'qc_engineer', 'qc_auditor'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
      </select>
      <span class="qc-user-flag">${u.permanent ? t('colPermanent') : t('colTemporary')}</span>
      <span class="qc-user-flag ${u.active ? 'active' : 'inactive'}">${u.active ? t('colActive') : t('colInactive')}</span>
      <button onclick="resetQcUserPassword(${u.id}, '${u.username}')">${t('resetPw')}</button>
      <button onclick="toggleQcUserActive(${u.id}, ${u.active ? 'false' : 'true'})">${u.active ? t('deactivate') : t('activate')}</button>
      <button class="btn-danger" onclick="deleteQcUser(${u.id}, '${u.username}')">${t('deleteBtn')}</button>
    </div>`).join('');
  loadAuditLog();
}

// #31: read-only audit trail of QC user management + session deletion
// actions (see db.logAudit's call sites in index.js). The section itself
// is only reachable via the Users tab, which is already gated to
// isEffectiveSupervisor() by applyRoleGatedUi() -- this just mirrors that
// same gate for the section's own visibility within the tab.
async function loadAuditLog() {
  const section = document.getElementById('audit-log-section');
  if (!section) return;
  if (!isEffectiveSupervisor()) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const res = await apiCall('GET', '/api/qc/audit-log');
  if (!res.ok) return;
  const entries = await res.json();
  const container = document.getElementById('audit-log-table');
  if (!entries.length) { container.innerHTML = `<div class="empty-hint">${t('noAuditLogYet')}</div>`; return; }
  container.innerHTML = `
    <table class="report-table">
      <thead><tr><th>${t('colTime')}</th><th>${t('colActor')}</th><th>${t('colAction')}</th><th>${t('colTarget')}</th><th>${t('colDetails')}</th></tr></thead>
      <tbody>${entries.map((e) => `
        <tr>
          <td>${e.created_at}</td><td>${e.actor}</td><td>${e.action}</td>
          <td>${e.target_type ? `${e.target_type}#${e.target_id}` : ''}</td><td>${e.details || ''}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function showCreateQcUser() {
  document.getElementById('qc-new-username').value = '';
  document.getElementById('qc-new-role').value = 'qc_engineer';
  document.getElementById('qc-new-permanent').checked = false;
  document.getElementById('qc-create-user-form').style.display = 'block';
}

async function submitCreateQcUser() {
  const username = document.getElementById('qc-new-username').value.trim();
  const role = document.getElementById('qc-new-role').value;
  const permanent = document.getElementById('qc-new-permanent').checked;
  if (!username) return;
  const res = await apiCall('POST', '/api/qc/users', { username, role, permanent });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || t('createUserError'));
    return;
  }
  const user = await res.json();
  document.getElementById('qc-create-user-form').style.display = 'none';
  showTempPassword(user.username, user.tempPassword);
  loadQcUsers();
}

function showTempPassword(username, tempPassword) {
  alert(`${t('tempPwShown')} "${username}" (${t('tempPwHint')}):\n\n${tempPassword}`);
}

async function changeQcUserRole(id, role) {
  await apiCall('PUT', `/api/qc/users/${id}`, { role });
  loadQcUsers();
}

async function resetQcUserPassword(id, username) {
  if (!confirm(`${t('confirmResetPw')} "${username}"?`)) return;
  const res = await apiCall('POST', `/api/qc/users/${id}/reset-password`);
  if (!res.ok) return;
  const user = await res.json();
  showTempPassword(username, user.tempPassword);
}

async function toggleQcUserActive(id, activate) {
  await apiCall('POST', `/api/qc/users/${id}/${activate ? 'activate' : 'deactivate'}`);
  loadQcUsers();
}

async function deleteQcUser(id, username) {
  if (!confirm(t('confirmDeleteUser'))) return;
  await apiCall('DELETE', `/api/qc/users/${id}`);
  loadQcUsers();
}

async function deactivateTempUsers() {
  if (!confirm(t('confirmDeactivateTemp'))) return;
  const res = await apiCall('POST', '/api/qc/users/deactivate-temp');
  if (res.ok) loadQcUsers();
}

// ── Tabs ──
function showTab(name) {
  document.querySelectorAll('.qc-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.qc-tab-content').forEach((el) => el.classList.toggle('active', el.id === `tab-${name}`));
  if (name === 'incidents') { loadIncidentsList(); loadSessionsTable(); }
  if (name === 'users') loadQcUsers();
  if (name === 'monitor') refreshOpenSessions();
}

// Periodic refresh of sessions/pending count (no WS push for these -- plain
// REST polling, same belt-and-suspenders pattern as viewer.js's admin panel).
setInterval(() => {
  refreshOpenSessions();
  refreshPendingCount();
  if (document.getElementById('tab-incidents')?.classList.contains('active')) loadIncidentsList();
}, 10000);

showLogin();
