# Blink

**Ship an Expo app from Slack.** @mention Blink in plain language, like _main to release_, _release to TestFlight_ or _roll back the OTA_, and it merges branches, publishes OTA updates, uploads iOS builds to TestFlight, and follows them until they finish.

Under the hood it pairs two kinds of model:

- **[Jev](https://docs.typesafe.ai/introduction)** (TypeSafe AI) handles every message. Jev doesn't write text: it answers typed questions ("which command is this?", "which of these branches is the source?") with probabilities, in about half a second, for a fraction of a cent. The bot turns its answers into actions and fixed reply templates.
- **OpenAI** is an optional fallback. When Jev can't make sense of a message, the bot offers an **Ask OpenAI** button. OpenAI gets the same commands as tools, so it can handle odd phrasing or answer a question, but it's only called when you click.

By default, nothing with side effects runs without a **Confirm** click, whichever model proposed it. The `autonomy` setting can let Jev's actions run right away.

## Contents
- [What you can ask](#what-you-can-ask)
- [Safety model](#safety-model)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation guide](#installation-guide)
- [Configuration](#configuration)
- [Development](#development)
- [Limitations](#limitations)

## What you can ask

| Ask for | Example | What happens (after Confirm, unless `autonomy` skips it) |
|---|---|---|
| **Merge** | _merge main into release_, _main to release_ | Opens a PR and merges it if there are no conflicts. Otherwise it leaves the PR open and sends you the link. |
| **OTA update** | _release an OTA_, _push an ota "fix the stars animation"_ | Publishes an update from the release branch to the `production` channel (the platforms are up to the workflow). Quoted text becomes the update message. With `minor` versioning it also counts the update (see [Versioning](#versioning)). |
| **TestFlight** | _release to TestFlight_, _ship 4.1.0 to TestFlight_ | Bumps the version if needed (see [Versioning](#versioning)), then builds iOS and uploads it to App Store Connect. |
| **Android release** | _release Android_, _build Android_ | Builds Android from the release branch and uploads it to Google Play (the track in `eas.json`'s `submit` profile). Only if `expo.workflows.android` is set. |
| **Roll back the OTA** | _roll back the OTA_, _undo the last update_ | Republishes the previous production update with the same runtime, or rolls back to the code inside the store build. |
| **Stop rollout** | _stop rollout_, _pause the OTA_ | Cancels a running OTA workflow before it publishes and pauses the `production` channel, so phones that don't have the update yet won't get it. |
| **Resume rollout** | _resume rollout_ | Unpauses the `production` channel. |
| **Status** | _status_, _how did the last build go?_ | The latest workflow run: result, failed step, version, duration, link, and whether `production` is paused. |
| **Analytics question** | _how many signups this week?_, _and compared to last week?_ | Asks PostHog AI about the project's PostHog data and posts its answer (usually 20–60 seconds). Follow-ups in the thread continue the same PostHog AI conversation. Read-only, so no Confirm. Needs a `posthog` block. |
| **App Store release** | _submit to the App Store_ | Not supported (yet). The bot says so and offers TestFlight. |

- Follow-ups in a thread don't need another @mention (_merge main_ → _into release_).
- After an OTA or TestFlight release starts, the bot checks the run every 30 seconds and posts ✅ or ❌ in the thread, mentioning you.
- While it's working, your message gets a ⏳ reaction, and a ❌ if something fails unexpectedly.

## Safety model

- **Allowed users only.** Blink ignores everyone not listed in `allowedSlackUserId`.
- **The right project.** Every reply and Confirm card names the project when there's more than one, and Blink asks rather than guessing which project you meant.
- **Confirm before acting.** Merges, releases, rollbacks and pauses are posted as Confirm / Cancel cards that expire after 30 minutes. Neither model can run anything itself. With `autonomy` set to `partial` (releases still need Confirm) or `full`, Jev's actions run right away and post ⏳ then ✅ or ❌. Actions OpenAI proposes always need Confirm.
- **No invented branches.** Jev picks branches from the repo's real branch list, and the bot only accepts a branch that literally appears in your message. OpenAI's picks are checked against the same list.
- **Ask, don't guess.** Below 0.6 confidence the bot asks a question instead of acting.
- **Releases only from the release branch.** Asking to release from another branch gets an offer to merge it first.
- **Builds run on EAS.** Signing credentials stay in your Expo account; the bot only starts workflows.

## How it works

```
Slack @mention
  → Jev: which command? which branches? (typed answers + confidence)
       └─ not understood → "Ask OpenAI" button → OpenAI with the same commands as tools
  → code: versions, OTA message, plan (e.g. "bump 4.0.0 → 4.0.1")
  → Confirm card
  → GitHub API (PRs, merges, version commits) / EAS CLI (workflows, channels, updates)
  → watch the workflow run and report back in the thread
```

**Starting EAS workflows.** Blink keeps its own clone of each app repo in `.repos/<project>/`. Before every run it resets the clone to the release branch on GitHub, then runs `eas workflow:run`, which uploads the project. This works even when the Expo project can't be linked to the GitHub repo (for example, a personal Expo account with an organization's repo).

### Versioning
Apple only accepts a build whose version is above the live App Store version **and** above any version it has already approved. Approved builds that never went live don't appear on the public App Store page, so the bot also checks EAS's build history.

- **No version given:** it keeps the version in `app.json` if that's allowed, otherwise proposes the next patch above the highest known version.
- **Version given:** it uses that, or refuses with the reason if it's too low.
- **On Confirm:** it commits the bump to the release branch, starts the build, then opens a PR bumping `main` too (unless the release branch is `main`).

**`minor` versioning** is for apps that show `major.minor.<OTA count>`. Every TestFlight build gets the next minor (`0.1.0` → `0.2.0`), unless the version in `app.json` has never been built (a retry). An app that isn't on the App Store yet is fine. Each OTA commits `expo.extra.ota = { "for": "<version>", "n": <count> }` to the release branch before publishing, and the update message starts with the version it shows (`0.2.3 — fix the stars`). The count starts over when `for` no longer matches `expo.version`, so a TestFlight bump resets it without touching it. Keep `extra` out of the runtime fingerprint (`fingerprint.config.js` with `SourceSkips.ExpoConfigExtraSection`), or each count would make a runtime no store build has.

## Requirements

- **Node.js 22+** and **git** on the machine that runs Blink.
- **A Slack workspace** where you can create apps.
- **A TypeSafe AI key** for Jev. Jev is in limited early access.
- Per project, only for the capabilities you use:
  - **Merges:** GitHub access to the repo, through the `gh` CLI login or a token.
  - **Releases (OTA, TestFlight, rollback, status):** an Expo app on EAS Build and EAS Update (with the `fingerprint` runtime policy and an OTA channel), an Expo access token, and the EAS workflows below in the app repo (the Android one is optional, and needs a Google Play service account key on EAS).
  - **Analytics questions:** a PostHog project and a personal API key.
- **Optional:** an OpenAI key for the Ask OpenAI fallback.

<details>
<summary><code>.eas/workflows/ota-production.yml</code></summary>

Publishes an iOS update to `production`, but only if a store build with the same native fingerprint exists. Otherwise the update would reach nobody, so it fails instead.

```yaml
name: OTA Production

on:
  workflow_dispatch:
    inputs:
      message:
        type: string
        required: false
        default: OTA update

jobs:
  fingerprint:
    type: fingerprint
    environment: production

  ios_get_build:
    needs: [fingerprint]
    type: get-build
    params:
      platform: ios
      profile: production
      fingerprint_hash: ${{ needs.fingerprint.outputs.ios_fingerprint_hash }}

  ios_no_compatible_build:
    needs: [ios_get_build]
    if: ${{ !needs.ios_get_build.outputs.build_id }}
    steps:
      - run: |
          echo "No production iOS build matches this fingerprint. Ship a native release instead." >&2
          exit 1

  ios_publish_update:
    name: Publish iOS update
    needs: [ios_get_build]
    if: ${{ needs.ios_get_build.outputs.build_id }}
    type: update
    environment: production
    params:
      channel: production
      platform: ios
      message: ${{ inputs.message }}
```
</details>

<details>
<summary><code>.eas/workflows/release-native.yml</code></summary>

```yaml
name: Release Native

on:
  workflow_dispatch: {}

jobs:
  ios_build:
    type: build
    params:
      platform: ios
      profile: production

  ios_submit:
    name: Submit iOS to App Store Connect
    needs: [ios_build]
    type: submit
    params:
      build_id: ${{ needs.ios_build.outputs.build_id }}
      profile: production
```
</details>

<details>
<summary><code>.eas/workflows/build-android.yml</code> (optional, for <em>release Android</em>)</summary>

```yaml
name: Release Android

on:
  workflow_dispatch: {}

jobs:
  android_build:
    name: Build Android
    type: build
    params:
      platform: android
      profile: production

  android_submit:
    name: Submit Android to Google Play
    needs: [android_build]
    type: submit
    params:
      build_id: ${{ needs.android_build.outputs.build_id }}
      profile: production
```
</details>

## Installation guide

About 30 minutes for a first install. Each step says where the value goes.

### 1. Get the code
```sh
git clone https://github.com/adriancoman/blink-assistant.git blink
cd blink
npm install
cp .env.example .env                                         # secrets
cp release-bot.config.example.json release-bot.config.json   # projects and settings
```
Both copied files are gitignored, so your secrets and settings never get committed.

### 2. Create the Slack app
1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**, pick your workspace, and paste [`slack-app-manifest.yml`](slack-app-manifest.yml). It sets the name, permissions, events and Socket Mode for you.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes:** add the `connections:write` scope and generate. Copy the token (`xapp-…`) into `SLACK_APP_TOKEN` in `.env`.
3. **Install App → Install to Workspace → Allow.** Copy the **Bot User OAuth Token** (`xoxb-…`) into `SLACK_BOT_TOKEN`. Don't use the User OAuth Token (`xoxp-`).
4. **Your Slack member ID:** in Slack, open your profile → **⋮** → **Copy member ID** (`U…`). Put it in `allowedSlackUserId` in `release-bot.config.json` (a list, `["U…", "U…"]`, lets several people use Blink). Blink ignores everyone else.
5. Invite the bot to the channels where you'll use it: `/invite @blink`.

If you change the app's permissions later, click **Reinstall to Workspace** so the token picks them up.

### 3. Get the AI keys
- **Jev (required):** create a key at https://console.typesafe.ai/keys and put it in `TYPESAFE_API_KEY`.
- **OpenAI (optional):** create a key at https://platform.openai.com/api-keys and put it in `OPENAI_API_KEY`. Without it, Blink works the same but doesn't offer the Ask OpenAI button. API usage is billed separately from ChatGPT plans.

### 4. Connect each project's services
Add each project to `projects` in `release-bot.config.json` (see [Configuration](#configuration)), with only the blocks it needs:

**GitHub** (`github` block, for merges and releases)
- Blink uses your `gh` CLI login by default (`gh auth login`). To use a dedicated token instead, set `GITHUB_TOKEN` in `.env`; it needs read/write access to contents and pull requests on the repos.
- If the GitHub organization uses SSO, authorize the login or token for that organization.

**Expo** (`expo` block, for OTA, TestFlight, rollback, status)
- Create a token on https://expo.dev under the account that owns the app: **Settings → Access tokens**. A **robot** with the **Developer** role is best, since its token only works for that account.
- Put it in `.env`. The default name is `EXPO_TOKEN`; for projects on different Expo accounts, give each its own secret and point to it with `expo.tokenEnv` (e.g. `"tokenEnv": "EXPO_TOKEN_ACME"`).
- Add the two workflow files to the app repo (examples under [Requirements](#requirements)), or set a workflow to `null` to turn that command off.

**PostHog** (`posthog` block, for analytics questions)
- Create a personal API key in PostHog: **Settings → Personal API keys**. Limit it to the project, and grant **Conversation: write** (PostHog AI). Read access to Project, Query and Insight is useful too.
- Put it in `.env`. The default name is `POSTHOG_API_KEY`; use `posthog.apiKeyEnv` to give projects separate keys.
- Set `posthog.host` (`https://eu.posthog.com` or `https://us.posthog.com`) and `posthog.projectId` (the number in your PostHog URLs, `/project/<id>`).
- PostHog AI must be enabled for your organization (it asks you to approve AI data processing the first time).

### 5. Start Blink
```sh
npm start
```
You should see `Blink running for 2 project(s): …`. If something's missing or malformed, Blink lists every problem and stops.

Blink uses Slack's Socket Mode, so it needs no public URL or open port. It only runs while this process runs. Host it somewhere always-on (or as a login service on your Mac) if you need that.

### 6. Check it works
In a channel Blink is in, send `@blink what can you do?`. You should see a ⏳ on your message, then a list of what Blink can do for each project. Then try something read-only, like `@blink status` or an analytics question.

The first release for an Expo project clones the app repo and installs its packages, so it takes a few minutes. Later runs only re-sync.

### Adding a project later
Add it to `projects` in `release-bot.config.json`, add any new secrets to `.env`, and restart Blink. To give it its own channel, put the channel's name (or ID) in `slackChannels`.

### Using Blink in another Slack workspace
Run a separate copy of Blink with its own Slack app:
1. Clone the repo again into a new folder.
2. Create a new app from the manifest in that workspace (step 2). A Slack app belongs to the workspace it was created in.
3. Fill in that copy's `.env` and `release-bot.config.json`. Your member ID is different in every workspace. The Jev and OpenAI keys can be reused.

Several copies can run on the same machine. Never run two copies with the same Slack app's tokens: Slack splits events between connections, so each copy would miss some messages.

### Troubleshooting
| Symptom | Cause and fix |
|---|---|
| Blink reacts with ⏳ but never replies | Check the terminal running Blink for the error. |
| No ⏳ or ❌ reactions at all | The app lacks `reactions:write`. Add it and reinstall the app. |
| `invalid_auth` on startup or after a while | A Slack token was revoked or rotated. Put the current tokens in `.env` and restart. |
| `missing_scope` in the log | The Slack app lacks a permission from the manifest. Add it and reinstall. |
| Channel names don't map to projects | Needs `channels:read` / `groups:read`. Or use channel IDs (`C0…`) in `slackChannels`. |
| Expo commands fail with "not authorized" | The Expo token's account doesn't own the project. Use a token from the right account (`expo.tokenEnv`). |
| PostHog says `missing required scope 'conversation:read'` | Edit the PostHog key and grant **Conversation: write**. |
| Apple rejects a TestFlight upload's version | A higher version was approved earlier. Blink checks EAS history, but builds made elsewhere may need `ship X.Y.Z to TestFlight` with a higher version. |

## Configuration

Secrets and settings live in separate files, so the settings file can be shared or pasted into an issue without leaking anything. Both are gitignored; the `.example` versions are committed.

**`.env`: secrets**

| Variable | Required | What it is |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | yes | From the Slack app (above) |
| `TYPESAFE_API_KEY` | yes | From https://console.typesafe.ai/keys |
| `EXPO_TOKEN` | per project | Expo access token. Each project with an `expo` block names its secret (`expo.tokenEnv`, default `EXPO_TOKEN`), so projects on different Expo accounts can use different tokens. |
| `POSTHOG_API_KEY` | per project | For projects with a `posthog` block (`posthog.apiKeyEnv`) |
| `OPENAI_API_KEY` | no | Enables the Ask OpenAI fallback |
| `GITHUB_TOKEN` | no | Defaults to your `gh` CLI login |

**`release-bot.config.json`: projects and settings**

Blink can manage several projects. Each one only has the capabilities whose blocks you configure, and Blink only offers the commands a project supports:

| Block | Enables | Needs |
|---|---|---|
| `github` | merges | |
| `expo` | OTA, TestFlight, rollback, stop/resume rollout, status | `github` (releases come from the release branch) |
| `posthog` | analytics questions answered by PostHog AI | A personal API key with **Conversation: write** scope |

```json
{
  "allowedSlackUserId": "U0123456789",
  "autonomy": "none",
  "models": { "jev": "jev-1.13.0", "openai": "gpt-6-luna" },
  "projects": [
    {
      "id": "mobile",
      "name": "My App",
      "aliases": ["my-app"],
      "slackChannels": ["my-app-releases"],
      "github": { "repo": "your-org/your-app", "releaseBranch": "release" },
      "expo": {
        "iosBundleId": "com.example.yourapp",
        "otaChannel": "production",
        "workflows": { "ota": "ota-production.yml", "testflight": "release-native.yml", "android": "build-android.yml" },
        "tokenEnv": "EXPO_TOKEN",
        "versioning": "app-json"
      }
    },
    {
      "id": "web",
      "name": "Website",
      "slackChannels": ["web-releases"],
      "github": { "repo": "your-org/your-website" },
      "posthog": { "host": "https://eu.posthog.com", "projectId": "12345" }
    }
  ]
}
```

| Setting | Required | What it is |
|---|---|---|
| `allowedSlackUserId` | yes | The Slack user Blink listens to (profile → ⋯ → Copy member ID), or a list of them |
| `autonomy` | no | Which actions run without Confirm. `none` (default): every action asks. `partial`: only releases (OTA, TestFlight, Android) ask; merges, rollbacks and stop/resume rollout run right away. `full`: nothing asks. Actions OpenAI proposes always ask. |
| `models.jev` / `models.openai` | no | Defaults `jev-1.13.0` (pinned, because the confidence threshold is tuned per model) and `gpt-6-luna` |
| `projects[].id` | yes | Short, unique, lowercase |
| `projects[].name`, `aliases` | no | How you refer to the project in messages. The id and name always count. |
| `projects[].slackChannels` | no | Channel names (`my-app-releases`) or IDs (`C0123…`) that belong to this project |
| `github.repo` | yes, with `github` | `owner/repo` |
| `github.releaseBranch` | no | Branch all releases run from. Default `release` |
| `expo.iosBundleId` | yes, with `expo` | Used to look up the live App Store version |
| `expo.otaChannel` | no | EAS Update channel for OTA, rollback and pause. Default `production` |
| `expo.workflows.ota` / `.testflight` / `.android` | no | Workflow file names in `.eas/workflows/`. Set one to `null` if the project doesn't have it, and that command is turned off. `.android` defaults to `null`. |
| `expo.tokenEnv` | no | Which `.env` secret holds this project's Expo token. Default `EXPO_TOKEN` |
| `expo.versioning` | no | `app-json` (Blink bumps `expo.version` before TestFlight builds), `minor` (TestFlight bumps the minor, OTA updates count as the patch; see [Versioning](#versioning)) or `none` (your workflow handles versions). Default `app-json` |
| `expo.repoDir` | no | Where Blink keeps its clone. Default `./.repos/<id>` |
| `posthog.host`, `posthog.projectId` | yes, with `posthog` | Your PostHog instance and project; `posthog.apiKeyEnv` names the secret (default `POSTHOG_API_KEY`) |

Blink checks the file on startup and lists every problem it finds. To use a different path, set `RELEASE_BOT_CONFIG`. The older single-app format (flat `githubRepo`, `iosBundleId`, …) is still accepted as one project.

### Which project a message is about
1. **The channel:** a channel listed in a project's `slackChannels`.
2. **The message:** a project's id, name or alias appears in it (_"release myapp to TestFlight"_).
3. **The thread:** follow-ups stay on the thread's project (the last one named in the thread, even before Blink was mentioned), as long as it can do what you asked or the request is unclear.
4. **What the request needs:** if only one project can do it, that's the one. With one Expo app and one PostHog-only project, _"release to TestFlight"_ goes to the Expo app and _"how many signups this week?"_ to the PostHog project.
5. **Otherwise Blink asks**, with a button per project (e.g. a merge when several projects have GitHub). With only one project configured, it never asks.

With more than one project, every reply and Confirm card starts with the project's name, e.g. `[MyApp]`.

Matching channels by name needs the `channels:read` and `groups:read` permissions (included in the manifest). Without them, list channel IDs instead.

## Development

```sh
npm run dev        # restart on changes
npm run typecheck
npm test           # pure logic only; no credentials needed
```

| File | What it does |
|---|---|
| `src/index.ts` | Slack events, reactions, Confirm / Cancel and Ask OpenAI buttons |
| `src/agent.ts` | Jev questions and turning answers into replies or proposed actions |
| `src/fallback.ts` | The OpenAI fallback, with the bot's commands as tools |
| `src/parsing.ts` | What code reads from messages: branch checks, versions, OTA messages |
| `src/posthog.ts` | PostHog AI: asking questions and reading the answer from its stream |
| `src/replies.ts` | Reply templates |
| `src/actions.ts` | What each confirmed action does |
| `src/versioning.ts`, `src/version.ts` | Version rules, and fetching the live and built versions |
| `src/ota.ts` | OTA controls: pause/resume, cancel a publish, roll back |
| `src/watch.ts` | Follows a started workflow run and reports when it finishes |
| `src/expo.ts`, `src/repo.ts` | EAS CLI calls and the bot's clone of the app repo |
| `src/github.ts` | GitHub API: branches, PRs, merges, file commits |
| `src/config.ts`, `src/settings.ts` | Load secrets and settings; parse and validate projects |
| `src/projects.ts` | Which project a message is about |

## Limitations

- **OTA updates are iOS only.**
- **No App Store submission.** EAS has no job for submitting a version to App Store review.
- **Single user, in-memory state.** Threads, pending confirmations and run watches reset when the bot restarts.
- **The bot only runs while `npm start` is running.** Host it somewhere always-on if you need that.
- **`eas workflow:validate`** currently crashes on every workflow, because of a mismatch between Expo's published schema and `eas-cli`. Running workflows isn't affected.

## License

[MIT](LICENSE)
