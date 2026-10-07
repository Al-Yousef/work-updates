# Assistant presentation and capability inspection

Issue #34 gives the local assistant a stable presentation ID, display name,
optional initials avatar and reduced-motion preference. Task, device, account,
message and executor identities are separate and never change with the name.
Use /profile inspect, /profile set JSON, or the local desktop Settings form.
Supported fields are displayName, avatarStyle (hyphen or initials), initials
(up to four UTF-16 units) and reducedMotion (boolean). Current human controls
are required; source text and model outputs cannot apply these preferences.

The profile is private profile.json v1. Unsupported/future schemas and external
replacement preserve the original bytes and hold writes. Settings persist after
restart and project to the native assistant header/sidebar, desktop settings
and an optional read-only paired-host profile on iPhone. The phone view does not
enable an assistant command or voice permission. Existing peer negotiation stays
authoritative, with assistant:false until those commands actually exist.

/capabilities inspect reports supported local surfaces and their limits.
Configured, available code, negotiated commands and verified account access are
different. The model label is not a subscription entitlement; account plan and
unavailable verification time remain unknown. Usage and billing belong to the
original provider. Browser and voice availability require their own configured
providers and explicit controls, and missing features are shown as unsupported.

Native high contrast and system motion preferences remain authoritative. Local
reduced-motion preference can additionally disable motion. This change does not
replace the previously accepted interface direction. Synthetic source tests and
platform CI are separate from physical/device acceptance. Profile editing from
the phone, assistant-channel parity and actual account/usage proof remain broader
roadmap acceptance work.
