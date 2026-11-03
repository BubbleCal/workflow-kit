# Model and tier selection

Keep all portable model choices in instance.json models. The execution role may
be null to inherit, or an explicitly user-authorized object with source_message_id,
model and thinking. Existing defaults remain inherit. New create_thread actions
put those supported fields into the native arguments, preserving per-task
overrides and historical immutable actions. Existing dispatch settings remain
unchanged.

Fast is a separate service tier. If the active native tool does not expose a tier
parameter, neither model/thinking nor a prompt proves Fast is disabled. Record
capability and actual native evidence separately. A saved global default or recent
UI selection alone does not prove a particular turn's effective tier. Never add
unsupported tool arguments, edit app internal state, or bypass a native UI access
restriction. Preserve active tasks and surface one exact human setting step when
the supported interface cannot apply the requested choice. Do not create test chats
unless the user explicitly asks.
