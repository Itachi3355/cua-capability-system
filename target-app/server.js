// Mock "Meridian Credit Union — Teller Console"
// Deliberately legacy: server-rendered, nested table layout, no test IDs, no
// semantic classes, inline styles, generic input names. Stand-in for a
// no-API back-office banking app.
//
// Error injection (for demonstrating replay error handling):
//   POST /admin/inject/session-timeout  -> next page view shows an expiry interstitial once
//   POST /admin/inject/slow             -> next request is delayed ~8s once
import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));

const MEMBERS = {
  12345: {
    id: 12345, name: "Margaret Chen", since: "2009-04-17", phone: "(555) 013-2247",
    accounts: [
      { type: "Savings", number: "SV-4471", balance: "4,821.77" },
      { type: "Checking", number: "CK-9016", balance: "1,203.15" },
    ],
  },
  23456: {
    id: 23456, name: "Raj Patel", since: "2015-11-02", phone: "(555) 019-8830",
    accounts: [
      { type: "Savings", number: "SV-5520", balance: "612.40" },
    ],
  },
  34567: {
    id: 34567, name: "Dana Whitfield", since: "2021-06-30", phone: "(555) 014-7719",
    accounts: [
      { type: "Checking", number: "CK-2203", balance: "8,940.02" },
      { type: "Savings", number: "SV-8817", balance: "15,002.66" },
    ],
  },
};
let nextRef = 70211;

// --- injection state ---
let injectTimeout = false;
let injectSlow = false;

app.post("/admin/inject/session-timeout", (req, res) => { injectTimeout = true; res.send("armed"); });
app.post("/admin/inject/slow", (req, res) => { injectSlow = true; res.send("armed"); });

app.use((req, res, next) => {
  if (req.path.startsWith("/admin/")) return next();
  if (injectSlow) { injectSlow = false; return setTimeout(next, 8000); }
  if (injectTimeout && req.method === "GET") {
    injectTimeout = false;
    return res.send(page("Session Notice", `
      <table border="0" cellpadding="12"><tr><td>
        <font color="#8b0000"><b>Your session has expired due to inactivity.</b></font><br><br>
        To protect member information, idle sessions are closed automatically.<br><br>
        <a href="${req.originalUrl}">Continue session</a>
      </td></tr></table>`));
  }
  next();
});

function page(title, body) {
  return `<html><head><title>Meridian CU Teller Console - ${title}</title></head>
<body bgcolor="#e8e4d8" text="#1a1a1a" style="font-family: Verdana, sans-serif; font-size: 12px;">
<table width="760" align="center" border="0" cellspacing="0" cellpadding="0">
  <tr><td bgcolor="#1f3a5f" style="padding:8px">
    <font color="#ffffff" size="4"><b>MERIDIAN CREDIT UNION</b></font>
    <font color="#c9d4e4" size="2">&nbsp;&nbsp;Teller Console v3.2.11</font>
  </td></tr>
  <tr><td bgcolor="#d4cdb8" style="padding:4px">
    <table border="0" cellspacing="0" cellpadding="2"><tr>
      <td><a href="/">Home</a></td><td>&nbsp;|&nbsp;</td>
      <td><a href="/members">Member Search</a></td><td>&nbsp;|&nbsp;</td>
      <td><font color="#777">Reports</font></td><td>&nbsp;|&nbsp;</td>
      <td><font color="#777">Administration</font></td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="#ffffff" style="padding:14px">${body}</td></tr>
  <tr><td bgcolor="#d4cdb8" style="padding:4px"><font size="1">For internal use only. Operator: T-0447</font></td></tr>
</table></body></html>`;
}

app.get("/", (req, res) => {
  res.send(page("Home", `
    <b>Welcome, Operator.</b><br><br>
    <table border="0" cellpadding="4">
      <tr><td>&raquo;</td><td><a href="/members">Member Search</a></td><td>Look up a member record</td></tr>
      <tr><td>&raquo;</td><td><font color="#777">End of Day</font></td><td>Unavailable at this station</td></tr>
    </table>`));
});

app.get("/members", (req, res) => {
  const q = (req.query.q || "").toString().trim();
  let resultsHtml = "";
  if (req.query.q !== undefined) {
    const matches = Object.values(MEMBERS).filter(
      (m) => String(m.id) === q || m.name.toLowerCase().includes(q.toLowerCase())
    );
    if (!q || matches.length === 0) {
      resultsHtml = `<br><table border="0" cellpadding="6" bgcolor="#fff3f3"><tr><td>
        <font color="#8b0000"><b>No members matched your search.</b></font>
        Verify the member number and try again.</td></tr></table>`;
    } else {
      const rows = matches.map((m) => `
        <tr bgcolor="#f4f1e8">
          <td>${m.id}</td><td><a href="/members/${m.id}">${m.name}</a></td>
          <td>${m.since}</td><td>${m.phone}</td>
        </tr>`).join("");
      resultsHtml = `<br><table border="1" cellspacing="0" cellpadding="4" width="100%">
        <tr bgcolor="#1f3a5f"><td><font color="#fff"><b>Member #</b></font></td>
        <td><font color="#fff"><b>Name</b></font></td>
        <td><font color="#fff"><b>Member Since</b></font></td>
        <td><font color="#fff"><b>Phone</b></font></td></tr>${rows}</table>`;
    }
  }
  res.send(page("Member Search", `
    <b>Member Search</b><br><br>
    <form method="GET" action="/members">
      <table border="0" cellpadding="3"><tr>
        <td>Member # or Name:</td>
        <td><input type="text" name="q" size="24" value="${q.replace(/"/g, "&quot;")}"></td>
        <td><input type="submit" value="Search"></td>
      </tr></table>
    </form>${resultsHtml}`));
});

app.get("/members/:id", (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).send(page("Not Found", `<font color="#8b0000"><b>No members matched your search.</b></font> <a href="/members">Back to search</a>`));
  const acctRows = m.accounts.map((a) => `
    <tr bgcolor="#f4f1e8"><td>${a.type}</td><td>${a.number}</td>
    <td align="right">$${a.balance}</td></tr>`).join("");
  res.send(page(`Member ${m.id}`, `
    <table border="0" cellpadding="3">
      <tr><td><b>Member #:</b></td><td>${m.id}</td></tr>
      <tr><td><b>Name:</b></td><td>${m.name}</td></tr>
      <tr><td><b>Member Since:</b></td><td>${m.since}</td></tr>
      <tr><td><b>Phone:</b></td><td>${m.phone}</td></tr>
    </table><br>
    <b>Accounts</b>
    <table border="1" cellspacing="0" cellpadding="4" width="100%">
      <tr bgcolor="#1f3a5f"><td><font color="#fff"><b>Type</b></font></td>
      <td><font color="#fff"><b>Account #</b></font></td>
      <td><font color="#fff"><b>Balance</b></font></td></tr>${acctRows}</table><br>
    <table border="0" cellpadding="4"><tr>
      <td>&raquo;</td><td><a href="/members/${m.id}/subaccount/new">Open Sub-Account</a></td>
      <td>&raquo;</td><td><a href="/members">New Search</a></td>
    </tr></table>`));
});

app.get("/members/:id/subaccount/new", (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).send(page("Not Found", `<font color="#8b0000"><b>No members matched your search.</b></font>`));
  const err = req.query.err === "nickname"
    ? `<table border="0" cellpadding="6" bgcolor="#fff3f3"><tr><td><font color="#8b0000"><b>Nickname is required.</b></font></td></tr></table><br>` : "";
  res.send(page("Open Sub-Account", `
    <b>Open Sub-Account for ${m.name} (#${m.id})</b><br><br>${err}
    <form method="POST" action="/members/${m.id}/subaccount/review">
      <table border="0" cellpadding="3">
        <tr><td>Product:</td><td>
          <select name="ptype">
            <option value="SV">Share Savings</option>
            <option value="MM">Money Market</option>
            <option value="CD">Certificate (12-mo)</option>
          </select></td></tr>
        <tr><td>Account Nickname:</td><td><input type="text" name="nick" size="24"></td></tr>
        <tr><td></td><td><input type="submit" value="Continue &raquo;"></td></tr>
      </table>
    </form>`));
});

const PRODUCT_NAMES = { SV: "Share Savings", MM: "Money Market", CD: "Certificate (12-mo)" };

app.post("/members/:id/subaccount/review", (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).send(page("Not Found", `<font color="#8b0000"><b>No members matched your search.</b></font>`));
  const { ptype, nick } = req.body;
  if (!nick || !nick.trim()) return res.redirect(`/members/${m.id}/subaccount/new?err=nickname`);
  res.send(page("Review Sub-Account", `
    <b>Review New Sub-Account</b><br><br>
    <table border="1" cellspacing="0" cellpadding="4">
      <tr bgcolor="#f4f1e8"><td><b>Member</b></td><td>${m.name} (#${m.id})</td></tr>
      <tr><td><b>Product</b></td><td>${PRODUCT_NAMES[ptype] || ptype}</td></tr>
      <tr bgcolor="#f4f1e8"><td><b>Nickname</b></td><td>${String(nick).replace(/</g, "&lt;")}</td></tr>
    </table><br>
    <font color="#8b0000">Confirming will open a live sub-account on the member's record.</font><br><br>
    <form method="POST" action="/members/${m.id}/subaccount/create">
      <input type="hidden" name="ptype" value="${ptype}">
      <input type="hidden" name="nick" value="${String(nick).replace(/"/g, "&quot;")}">
      <input type="submit" value="Confirm and Open Account">
      &nbsp;&nbsp;<a href="/members/${m.id}/subaccount/new">&laquo; Go back</a>
    </form>`));
});

app.post("/members/:id/subaccount/create", (req, res) => {
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).send(page("Not Found", `<font color="#8b0000"><b>No members matched your search.</b></font>`));
  const ref = `SA-${nextRef++}`;
  m.accounts.push({ type: PRODUCT_NAMES[req.body.ptype] || "Sub-Account", number: ref, balance: "0.00" });
  res.send(page("Confirmation", `
    <table border="0" cellpadding="8" bgcolor="#eef7ee"><tr><td>
      <font color="#1a6b1a" size="3"><b>Sub-account opened successfully.</b></font><br><br>
      Reference number: <b>${ref}</b><br>
      Member: ${m.name} (#${m.id})
    </td></tr></table><br>
    <a href="/members/${m.id}">Return to member record</a>`));
});

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => console.log(`Meridian CU mock listening on http://localhost:${PORT}`));
