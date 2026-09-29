# If a request is interrupted

When a connection drops, or a reply takes longer than 30 seconds, Vectory can't know whether your change happened. It never guesses and never resends on its own. It keeps the request, so you can check what happened and decide.

## What you can do

| Action | What it does |
| --- | --- |
| **Check status** | Asks the server what happened to the original request. It never sends the change again. |
| **Retry same request** | Sends the original request again, with its original ID. If the first attempt already succeeded, the server returns that result instead of making a second change. |
| **Cancel request** | For requests that create a secret, such as a token or a reset link: stops a late request from completing and revokes anything it already created. |
| **Dismiss reminder** | Removes the reminder from this browser. It doesn't cancel anything on the server. |

Check first, then retry or cancel. Start a new, different request only once you know how the first one ended.

## The rules

- **A timeout isn't a failure.** It ends the wait in your browser, not the work on the server.
- **"Not found" isn't a failure either.** The server hasn't recorded the request yet, and it may still arrive. To be sure it never does, cancel it.
- **Nothing is resent automatically**, not even after a reload.
- **Secrets are never kept for replay.** Passwords, codes and tokens are cleared from the form. A lost token or reset link can't be shown again; cancel it and create a new one.
- **Reminders stay in this browser**, for your account only, across tabs and reloads. They hold what's needed to check the request, never passwords or tokens. Clearing site data removes them.

Lost a reminder, or working from another device? Most areas keep a list of your recent requests on the server. It can confirm a result, but it can't rebuild a missing request for a retry.

## Where to find each request

### Pipelines and deployments

| You were | Find it in | Server-side list |
| --- | --- | --- |
| Creating or duplicating a pipeline | **Pipelines → Review pipeline requests** | **Your pipeline requests** |
| Publishing a version | The editor's **Close and review request**, then **Review publish requests** | **Actions → Your publish requests** |
| Deploying or rolling back | **Confirm deployment** or **Confirm rollback** in the dialog, or **Review requests** | **Activity → Deployments → Your recent requests** |
| Saving agent settings | **Devices → Agent settings → Review settings requests** | **Your settings requests** |
| Creating a group | **Review group requests** | **Your recent group requests** |

A deployment's reminder confirms that the server saved it. Devices still have to apply it; follow the rollout until they report **Applied**.

### Devices and tokens

| You were | What to do |
| --- | --- |
| Creating an enrollment token | In **Add device**, open **Token requests → Check request**. If the token didn't reach you, choose **Cancel request** (or **Revoke token and cancel**) and wait for **Request cancelled** before you create another. |
| Authorizing device recovery | On the device page, open **Device recovery → Check request**. Cancel it the same way before you authorize again. Once the host has used the token, cancelling can't undo the new identity. |
| Revoking a device | Under **Device access**, choose **Check revocation**. Revoke again only if the check shows the device is still active. |
| Retrying a device, pausing a rollout or removing an assignment | Choose **Check status** (or **Check current status**). Controls stay unavailable until a fresh check succeeds. |

### Accounts and sign-in

| You were | What to do |
| --- | --- |
| Signing in | Vectory checks your session automatically. If it still can't tell, it says **We couldn't confirm your sign-in**: enter your password again. |
| Setting up the first administrator | Vectory checks automatically. If setup didn't finish, paste the setup secret and choose your password again. |
| Signing out | Open the account menu and choose **Check sign-out status**, or **Check again** in the dialog. |
| Adding a person, creating a reset link, editing access, or turning two-factor on or off | The dialog shows **We couldn't confirm that**. Choose **Check again**; it only reads. Act again only if it says nothing changed. |
| Changing your password | Sign in with the new password. If it doesn't work, try the old one. |
| Setting a new password from a reset or invite link | Try signing in with the new password. If that fails, ask for a new link. |

Account reviews live only on the open page, because they involve passwords. Resolve them before you leave the page.

## Keep work safe while you wait

- An unsaved pipeline stays in the editor while you check a request.
- Opening help or another tab never cancels a pending request.
- Signing out, reloading or leaving a page ends the wait but not the request. Check its status when you return.
