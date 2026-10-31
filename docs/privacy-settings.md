# Privacy Settings

Settings ▸ Privacy ▸ Privacy Controls manages who can reach you, search
visibility, embedded content, and GIF privacy. This page explains the
friend-request controls, including the parts that are not obvious from the
interface.

## Settings navigation

Privacy, account protection, and device permissions have separate homes:

| Main section | Subsections |
|---|---|
| **Privacy** | Privacy Controls, Rich Presence, Activity History |
| **Account** | Profile Information, Subscription, NSFW Content Access |
| **Security** | Change Password, Multi-Factor Authentication, SSO Security, Active Sessions, Past Sessions |
| **About & Updates** | Client Info, Update Settings, System Permissions, Developer |

Subsections appear beneath their main section in Settings navigation. Select a
subsection to open it and move to its controls. Sections start collapsed on a
fresh renderer session. The app remembers main and nested expansion choices
while you use Settings and for 30 minutes after you leave; reopening Settings
within that window restores them. After that window, or after reloading the
interface, sections start collapsed again. **Expand all** and **Collapse all**
apply to the current pane.

**Account ▸ Subscription** shows your current Sonic or Supersonic access,
benefits, and code redemption in one place. **Compare planned options** opens
the [product comparison page](https://concordvoice.com/compare/). Paid
subscriptions are planned; options and prices may change.

**Privacy ▸ Rich Presence** controls live activity visibility. **Privacy ▸
Activity History** is a separate, optional, server-readable record of later
Custom Status changes. It is off by default and requires explicit consent;
availability depends on the instance. When available, you can choose 7, 30,
90, or 365 days of retention. Turning it off or choosing **Delete history and
turn off** deletes the stored history and stops recording. See the
[Privacy Policy](privacy-policy.md) for the data-handling details.

**About & Updates ▸ Client Info** places **Legal & Attribution** above
**Third-Party Services**. The documents are **License**, **Privacy Policy**,
**Terms of Service**, and **Third-Party Software Disclosure**; the latter
displays the source `NOTICE.md`. Document content follows the source files,
with Markdown formatting where applicable. The KLIPY service entry includes
**Powered by KLIPY** attribution and its
[privacy policy](https://klipy.com/support/privacy-policy). GIF privacy
controls remain together under **Privacy Controls**.

## Friend-request enforcement

Your choices are enforced by the server, not by the app. Hiding a button in the
client is a convenience; the server rejects a disallowed request regardless of
what any client shows.

## Who Can Send You Friend Requests

Three modes, from most to least restrictive:

| Mode | Who may send you a friend request |
|---|---|
| **No One** | Nobody — including anyone holding one of your friend codes. |
| **Mutual Servers** | People who share a server or an accepted friend with you, plus anyone who claims one of your valid friend codes. This is the default. |
| **Everyone** | Anyone. |

Your saved choice stays in place when the default changes.

Under **Mutual Servers**, a valid friend code lets its holder reach you even
without a shared server or friend. Choose **No One** and claiming that code is
refused. A code can travel further than you intended after you share it. The
setting gives you a way to close that door.

### Choosing "No One" does not touch requests you already have

This is the part people expect to work the other way. Selecting **No One**
blocks *new* requests only. Any request already sitting in your inbox stays
there, and **you can still accept it.**

That is deliberate. The alternative — silently declining everything pending the
moment you change a preference — would turn a settings toggle into a bulk
destructive action, and it would tell whoever sent the request the exact moment
you changed your mind. Neither is what a privacy control should do.

If you want to clear existing requests, decline them from your friend requests
list.

### What other people see

The app can hide the Send Friend Request button when your settings disallow a
request. An account that appears in Add Friend search can still have an Add
Friend button, even if that account does not accept requests from the person
searching. Pressing it does not bypass your choice: the server refuses the
request. A privacy restriction and a block get the same refusal, so the person
is not told which one applies.

Someone who already knows your exact username or user ID can still tell whether
your account exists by trying a direct friend request. The server returns
"User not found" for an unknown account and a generic refusal for an existing
account that does not accept their request. This does not put you in general
username search. Search visibility has its own setting.

Your relationships can change, so who qualifies under **Mutual Servers** can
change too. **No One** stops new requests regardless of shared servers, mutual
friends, or friend codes.

### Searchable by Username

This setting is off by default. When it is off, you do not appear in Add Friend
search, even to someone who shares a server or an accepted friend with you.
People in your servers can still see you in those servers' member lists, and
your existing friends can still see you in their Friends lists. Those lists
show relationships that already exist; Add Friend search is a separate way to
discover an account.

### How Mutual Servers works

The name covers one of three ways someone can reach you. You can share a server
or an accepted friend, or someone can claim one of your valid friend codes. Any
one of those is enough while **Mutual Servers** is selected.

- Someone with permission to invite members who already knows your user ID can
  add you to their server without your consent. Server owners have that
  permission. The new membership can allow a request under **Mutual Servers**.
  Leaving the server removes that shared-server path, though a mutual friend or
  valid code can still qualify.
- Being **banned** from a server removes your membership, so a banned user no
  longer shares that server with you.
- Being **timed out** does not. A timed-out member is still a member, so they
  still count as sharing a server. Timeouts are temporary moderation state and
  do not change who can befriend you.

## Self-hosted servers

The **Who Can Send You Friend Requests** control needs a server version that
supports it. If you are connected to a self-hosted server that predates this
control:

- **The setting will not save.** You will see *"This version of the server
  doesn't support this setting yet."* beneath the control. Nothing was changed
  on the server; the message is not a transient error and retrying will not
  help.
- **The app cannot check request eligibility.** It may show the Send Friend
  Request button when a request will fail. The server still decides whether to
  accept the request.

Ask your server operator to update the control plane. Until then, treat the
friend-request control as unavailable rather than as set to "Everyone".

## Related

- [Self-Hosted Desktop Client](self-hosted-client.md) — connecting to a
  self-hosted control plane
- [Privacy Policy](privacy-policy.md) — what data the service holds, which is
  a separate question from these per-account controls
