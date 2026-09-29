# Get started

Vectory manages Vector configurations across your devices. Build a pipeline, publish an immutable version, then choose the devices that should run it. Your logs and metrics flow through Vector; Vectory receives configuration status and the operational metrics you enable.

## Open your workspace

Use your instance's dashboard address and sign in with your email and password. If two-factor authentication is enabled, enter an authenticator code or an unused recovery code when asked. A new instance instead asks for its provisioned setup secret and the first administrator's details.

If loading stalls, use **Retry connection**. Each connection or sign-in attempt stops waiting after 30 seconds. A lost sign-in response does not mean the sign-in failed: use **Check sign-in status** to check this browser's current session without sending your password or verification code again. During first-time setup, use **Check setup status** before trying another setup. See [Recover an interrupted sign-in](#/docs/troubleshooting#loading-or-sign-in-does-not-finish) for the available next steps. Documentation remains available while the dashboard connects.

If a page fails to open after sign-in, its recovery view keeps navigation available and offers **Reload page**. A stalled page download stops waiting after 30 seconds. See [Recover a page that cannot load](#/docs/troubleshooting#a-page-is-blank-or-cannot-load) for next steps and the limits of recovering unsaved work.

## Your first deployment

1. Open [**Devices → Add device**](/#/enrollment). Download the agent for the device's operating system and architecture. Vector 0.58.0 must already be installed.
2. Follow the [installation guide](#/docs/installation) to adopt one Vector process, choose restricted or full configuration mode, and enroll the device. Enrollment does not assign a pipeline.
3. Open [**Pipelines**](/#/configurations) and create a pipeline or import an existing Vector configuration. Add a source, any transforms you need, and a sink. Connect them in the graph.
4. Configure each component. Run validation, fix reported errors, and save the draft. Use [pipeline tests](#/docs/resources) when you need to verify event transformation behavior.
5. Publish a version. Open its deployment action, select a device or group, and preview the exact target list before confirming.
6. Open [**Activity → Deployments**](/#/deployments) to watch progress. On the device page, wait for **Applied**: a downloaded or written file alone does not mean Vector is running it.

## Know which action you are taking

**Save** updates the editable draft. **Publish** freezes that draft as a version. **Deploy** creates an assignment for selected devices. Editing a draft after publication does not change a running deployment.

You can [roll back](#/docs/deployments) to an earlier published version. A rollback creates a new desired generation so devices can accept it without weakening their protection against stale messages.

## Navigate your workspace

Hover over the sidebar to reveal the arrow on its right edge. Click it to collapse the sidebar or expand its labels; Vectory remembers your choice in this browser. The arrow also appears when reached with the keyboard. On a phone, open navigation from the menu button. The instance name is available in [**Settings**](/#/settings).

Select your name or avatar at the bottom of navigation to open the account menu. It contains [**Settings**](/#/settings), Vectory documentation and **Sign out**. Open Settings, then the [**People & security**](/#/users) tab to manage account security and workspace access. Choose **Light**, **Dark** or **Auto** for appearance; Auto follows your system's current theme. Escape dismisses the menu without leaving the page.

Use **Find a page**, or press **Ctrl K** (**⌘ K** on Mac), to jump to a workspace page. Search by its name or a related task, such as “install”, “deployments” or “MFA”. Use the up/down arrows to choose a result and Enter to open it; Escape closes search and returns focus. The current page is marked, and Help center opens in a separate tab. Navigation still protects unfinished pipeline edits.

In [**Overview**](/#/overview), a resource name under **Recent activity** opens that pipeline, device or deployment. A person's name opens their activity history. Select the event title to read its audit entry.

## Sign out of your workspace

Open your account menu and choose **Sign out**. Before sending the request, **Cancel** or Escape returns to the workspace without signing out. Vectory also asks before leaving unsaved pipeline changes.

Once the request starts, you can use **Stop waiting**, close the dialog or press Escape. This ends the local wait, not the server operation. A response wait ends after 30 seconds. If sign-out is not confirmed, choose **Check sign-out status** in the dialog or reopen it from your account menu. Checking reads the current session without sending another sign-out.

If the original session is still active, **Retry sign out** is a separate choice. If no active session is found, **Go to sign in** checks for unsaved changes before leaving. If the sign-in changed, **Reload workspace** checks for unsaved changes and reads the current account afresh. See [Recover an interrupted sign-out](#/docs/troubleshooting#sign-out-is-not-confirmed) for details.

## Choose the right access

- **Viewer:** inspect devices, pipelines, deployments and activity.
- **Editor:** create, edit and validate configuration drafts.
- **Operator:** publish and deploy versions, deploy agent settings, and manage operational actions.
- **Administrator:** manage enrollment, device access, users and instance settings as well as operational work.

Available controls follow your role. The server checks permissions independently of the dashboard.

## If a device does not apply

Open the device's **Activity** tab and read the reported issue. Common causes are an unreachable server, a local pause, a restricted capability, an unavailable file or credential, and a failed Vector health check. Follow the [troubleshooting guide](#/docs/troubleshooting) before retrying.

See [terms and concepts](#/docs/glossary) for unfamiliar labels, or the [official Vector introduction](https://vector.dev/docs/introduction/) for the underlying data pipeline model.
