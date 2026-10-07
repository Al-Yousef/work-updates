'use strict';
const policy = {
  'documents.json':['Imported local copies, edit drafts and explicit output schedules','128 copies/drafts, 32 finite schedules and 1000 receipts','Private export; cancel schedule separately; output files and receipts retained'],
  'state.json':['Task metadata, status, preferences and groups','Component bounds; no automatic age expiry','Private export; original task controls; no blanket deletion'],
  'messages.json':['Message intents and exact delivery receipts','Up to 10000 intents; replay guards retained','Private redacted export; cancel unsent intents separately'],
  'assistant.json':['Conversation, pinned notes and assistant replay guards','500 exchanges, 40 alerts, 32 notes; guards retained','Scoped note/conversation previews; guards and unselected notes remain'],
  'device.json':['Local device identity','Until local identity reset','Private export; identity is not task identity'],
  'drafts.json':['Desktop drafts and attachment references','Until submitted, changed or explicitly cleared','Private export; composer controls; images are separate'],
  'responsibilities.json':['Human instructions and responsibility checkpoints','Component bounds; completion retains evidence','Private export; cancel/stop controls retain original receipts'],
  'schedules.json':['Schedule grants, wakes and run receipts','Finite grants; saved run/replay checkpoints retained','Private export; explicit cancellation stops future wakes'],
  'authorizations.json':['Human grants, revocations and action receipts','Finite grants; revocation/replay evidence retained','Private export; revoke access independently of stored content'],
  'commitments.json':['Action items and user corrections','Component bounds; original evidence retained','Private export; original commitment controls'],
  'delegations.json':['Child scopes, accepted turns and parent reviews','Component bounds; restart/replay checkpoints retained','Private export; stop does not erase accepted external work'],
  'research.json':['Read grants and retained source extracts','64 statements and 32 scans per scope; grants bounded','Private export; revoke stops future reads; extracts remain'],
  'work-controls.json':['Stop/resume holds and resource checkpoints','Component bounds; replay guards retained','Private export; no deletion that silently resumes work'],
  'reflections.json':['Review scopes, source statements and suggestions','Configured 1..365 days for old review checkpoints','Private export; original review controls; pinned notes separate'],
  'triage.json':['Notification rules, findings and delivery decisions','256 findings and 512 decisions; finite rules','Private export; disable notifications separately'],
  'activity.json':['Content-free action/access event metadata','Default 30 days/2048 events; explicit configurable limits','Existing redacted activity export and retention controls'],
  'outcomes.json':['Outcome requirements and verification evidence','Finite freshness scope; saved verification checkpoints','Private export; original outcome controls'],
  'budgets.json':['Resource reservations and budget policy','Finite windows; uncertain reservations retained','Private export; budget controls do not erase billable actions'],
  'executors.json':['Private executor bindings and revoked grants','Up to 2048 entries; grants retained until reviewed reset','Private redacted export; explicit revoke stops future dispatch'],
  'privacy.json':['Disconnects, previews and deletion checkpoints','30-minute previews; 512 removal receipts retained','Inspect controls; no export or reset that reenables replay'],
};
function inventory(versions) {
  const local = Object.keys(versions).map(name => {
    const p=policy[name] || ['Private component state','Original component limits; recovery required for unknown format','No deletion adapter; use original component controls'];
    return {name,location:'local app data',data:p[0],retention:p[1],access:'local authenticated app',exportDeletion:p[2],removal:p[2],credentialExport:false};
  });
  return local.concat([
    {name:'observer/data/source-cache.json + feed.json + details-request.json',location:'local app data',retention:'Collector cache; disconnect retains prior records',access:'local collector; connected snapshots',removal:'Exact disconnected source preview; derivatives remain'},
    {name:'attachments/',location:'local app data',retention:'No automatic expiry; referenced by drafts/history/receipts',access:'local app; explicitly selected dispatch',removal:'Dependency-aware removal adapter pending'},
    {name:'logs/',location:'local app data',retention:'Each logger: 512 KiB plus two backups maximum',access:'local app; explicit redacted diagnostic export',removal:'Explicit diagnostic file cleanup pending'},
    {name:'exports/',location:'local app data',retention:'Until explicitly removed by owner; no automatic sharing',access:'local owner; exported files remain private',removal:'Original files; export copies do not track later deletion'},
    {name:'paired-devices.enc / paired-host.enc',location:'OS-encrypted local app data',retention:'Until forgotten/revoked; invalid encryption is held',access:'local OS protected app; never plaintext export',removal:'Forget/revoke pairing; remote retained content is separate'},
    {name:'iPhone draft journal / Keychain',location:'paired phone only',retention:'128 drafts and 512 receipts; credential until forgotten',access:'phone file protection/Keychain and paired authenticated host',removal:'Phone-owned controls; desktop cannot erase it'},
    {name:'Codex chats / provider storage',location:'original provider',retention:'Provider policy; app does not control remote retention',access:'exact connected source/account grants',removal:'Original provider controls; does not reverse external actions'},
  ]);
}
module.exports={inventory};
