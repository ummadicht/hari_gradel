# Merge a local .env.local into the VM's, never overwrite it (SUP-84).
#
#   awk -f deploy/merge-env.awk .env.local - < incoming.env > .env.local.new
#
# The first file is the VM's current env, stdin is the one being deployed.
#   - Auth and server keys (PROTECTED below) are ALWAYS the VM's: they are set
#     on the VM by deploy/set-keycloak-env.sh / set-auth-mode.sh, and a
#     deploy must never drop them (losing GIQ_AUTH_MODE would put staff back on
#     passwords) nor replace them with a laptop's dev values (a localhost
#     redirect URI). A protected key in the incoming file is ignored.
#   - Any other key: the incoming value wins (rotating e.g. a Gemini key by
#     deploy keeps working); keys only the VM has are kept.
# Comments and blank lines come from the incoming file.
BEGIN {
  P = "^(GIQ_AUTH_MODE|KEYCLOAK_ISSUER|OIDC_[A-Z_]+|SVC_CLIENT_[A-Z_]+|SUPERIQ_DIAGNOSTICS_URL|PUBLIC_ORIGIN|GRADEIQ_SERVER_KEY|GRADEIQ_RETAIL_KEY|PRICEBOOK_SYNC_SECRET|SUPERIQ_TOKEN|PORTAL_PW_[A-Z_]+|ENT_USER|ENT_PASS)$"
  vmfile = ARGV[1]
}
function key(l) { sub(/^[ \t]*(export[ \t]+)?/, "", l); sub(/[ \t]*=.*/, "", l); return l }
function iskey(l) { return l ~ /^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=/ }
FILENAME == vmfile {
  if (iskey($0)) {
    k = key($0)
    if (k ~ P) keep[++n] = $0
    else { if (!(k in vm)) ord[++m] = k; vm[k] = $0 }
  }
  next
}
iskey($0) { k = key($0); if (k ~ P) next; inc[k] = 1 }
{ print }
END {
  for (i = 1; i <= m; i++) if (!(ord[i] in inc)) print vm[ord[i]]
  for (i = 1; i <= n; i++) print keep[i]
}
