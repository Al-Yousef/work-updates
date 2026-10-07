#pragma once
// Only --audit-capture sessions expose these hit centers to the native audit.
// Tests still click the visible window; no queue/backend action is invoked here.
enum class AuditAction {DetailsMenu,FilterMenu,AddMenu,Open,Reviewed,Snooze,Undo,Updates,Queued,History,Done,ClearQueue,Memory,UseDraft,Send,Attach,Queue,SendNow,Previous,Source,Checked,Browse,ClearSearch,CopyMessage,Latest,Assistant,CompleteTask,ReopenTask};
constexpr const char* auditActionNames[]{"detailsMenu","filterMenu","addMenu","open","reviewed","snooze","undo","tab0","tab1","tab2","tab3","clearQueue","memory","assistantUse","send","attach","queue","sendNow","previous","source","checked","browse","clearSearch","copyMessage","chatLatest","assistant","done","reopen"};
