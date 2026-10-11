# Blink

**Run your releases from Slack.** @mention Blink in plain language, like _main to release_, _release to TestFlight_ or _roll back the OTA_. It merges branches, publishes and rolls back Expo OTA updates, builds for TestFlight and Google Play, follows each run until it finishes, and answers analytics questions from PostHog. One bot can look after several projects.

Two models share the work:

- **[Jev](https://docs.typesafe.ai/introduction)** (TypeSafe AI) reads every message and answers typed questions ("which command is this?", "which branch?") with confidence scores. Blink turns the answers into actions.
- **OpenAI** (optional) only runs when you click **Ask OpenAI** on a message Jev couldn't place, or **Explain with OpenAI** on a failed run.

Nothing with side effects runs without a **Confirm** click, unless you relax the `autonomy` setting.

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

| Ask for | Example |
|---|---|
| **Merge** | _merge main into release_, _main to release_ |
| **OTA update** | _release an OTA_, _push an ota "fix the stars animation"_ |
| **TestFlight** | _release to TestFlight_, _ship 4.1.0 to TestFlight_, _release to TestFlight locally_ |
| **Android release** | _release Android_ |
| **Roll back the OTA** | _roll back the OTA_, _undo the last update_ |
| **Stop / resume rollout** | _stop rollout_, _resume rollout_ |
| **Status** | _status_, _how did the last build go?_ |
| **Why it failed** | _what's the error?_, _show me the logs_ |
| **Analytics question** | _how many signups this week?_ |

Follow-ups in a thread don't need another @mention. After a release starts, Blink follows the run and posts ✅ or ❌ in the thread.

## Safety model

- **Allowed users only.** Blink ignores everyone not listed in `allowedSlackUserId`.
- **Confirm before acting.** Actions are posted as Confirm / Cancel cards; neither model runs anything itself. `autonomy` can relax this for Jev's actions, never for OpenAI's.
- **No invented branches.** Branches must exist in the repo and appear in your message.
- **Ask, don't guess.** When unsure of the command or the project, Blink asks.
- **Releases only from the release branch.**
- **Secrets stay put.** Signing credentials stay in your Expo account, and the app's install scripts never see Blink's secrets.

## How it works

```
Slack @mention
  → Jev: which command? which branches? (typed answers + confidence)
       └─ not understood → "Ask OpenAI" button → OpenAI with the same commands as tools
  → Confirm card
  → GitHub API (PRs, merges, version commits) / EAS CLI (workflows, channels, updates)
  → watch the run and report back in the thread
```

Blink keeps its own clone of each app repo in `.repos/<project>/` and starts EAS workflows from it, so the Expo project doesn't need to be linked to GitHub.

## Requirements

- **Node.js 22+** and **git** on the machine that runs Blink.
- **A Slack workspace** where you can create apps.
- **A TypeSafe AI key** for Jev (limited early access).
- Per project, only for the capabilities you use:
  - **Merges:** GitHub access to the repo (`gh` login or a token).
  - **Releases:** an Expo app on EAS Build and EAS Update, an Expo access token, and the EAS workflows below in the app repo.
  - **Analytics:** a PostHog project and a personal API key.
- **Optional:** an OpenAI key; macOS with Xcode, CocoaPods and fastlane for TestFlight builds on the machine running Blink (`expo.localBuild`).

<details>
<summary><code>.eas/workflows/ota-production.yml</code></summary>

Publishes an iOS update to `production`, but only if a store build with the same native fingerprint exists.

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

### 1. Get the code
```sh
git clone https://github.com/adriancoman/blink-assistant.git blink
cd blink
npm install
cp .env.example .env                             # secrets
cp blink.config.example.json blink.config.json   # projects and settings
```

### 2. Create the Slack app
1. At https://api.slack.com/apps → **Create New App** → **From a manifest**, paste [`slack-app-manifest.yml`](slack-app-manifest.yml).
2. **Basic Information → App-Level Tokens:** generate one with `connections:write` and put it (`xapp-…`) in `SLACK_APP_TOKEN`.
3. **Install App → Install to Workspace**, and put the **Bot User OAuth Token** (`xoxb-…`) in `SLACK_BOT_TOKEN`.
4. In Slack, open your profile → **⋮** → **Copy member ID** and put it in `allowedSlackUserId` in `blink.config.json`.
5. Invite the bot to your channels: `/invite @blink`.

### 3. Get the AI keys
- **Jev (required):** https://console.typesafe.ai/keys → `TYPESAFE_API_KEY`.
- **OpenAI (optional):** https://platform.openai.com/api-keys → `OPENAI_API_KEY`.

### 4. Connect each project's services
Add each project to `projects` in `blink.config.json` (see [Configuration](#configuration)), with only the blocks it needs:

- **GitHub:** Blink uses your `gh` login, or `GITHUB_TOKEN` with read/write access to contents and pull requests.
- **Expo:** create an access token on https://expo.dev (a robot with the Developer role is best) and put it in `EXPO_TOKEN`, or in a secret named by `expo.tokenEnv`. Add the workflow files above to the app repo.
- **PostHog:** create a personal API key with **Conversation: write** scope and put it in `POSTHOG_API_KEY`. Set `posthog.host` and `posthog.projectId`.

### 5. Start Blink
```sh
npm start
```
Blink uses Socket Mode, so it needs no public URL. If the config has problems, it lists them and stops. Check it works with `@blink what can you do?`.

To use Blink in another Slack workspace, run a separate copy with its own Slack app.

### Troubleshooting
| Symptom | Cause and fix |
|---|---|
| ⏳ but no reply | Check the terminal running Blink for the error. |
| `invalid_auth` / `missing_scope` | A Slack token was rotated, or a permission is missing. Update `.env` or reinstall the app. |
| Channel names don't map to projects | Needs `channels:read` / `groups:read`, or use channel IDs (`C0…`). |
| Expo commands fail with "not authorized" | The token's account doesn't own the project. Use `expo.tokenEnv`. |
| PostHog says `missing required scope 'conversation:read'` | Grant the key **Conversation: write**. |

## Configuration

Secrets live in `.env`, settings in `blink.config.json`. Both are gitignored.

| `.env` variable | Required | What it is |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | yes | From the Slack app |
| `TYPESAFE_API_KEY` | yes | Jev |
| `EXPO_TOKEN` | per project | Expo access token (name set by `expo.tokenEnv`) |
| `POSTHOG_API_KEY` | per project | PostHog key (name set by `posthog.apiKeyEnv`) |
| `OPENAI_API_KEY` | no | Enables the OpenAI fallback |
| `GITHUB_TOKEN` | no | Defaults to your `gh` login |

Each project only gets the capabilities whose blocks you configure:

| Block | Enables |
|---|---|
| `github` | merges |
| `expo` | OTA, TestFlight, Android, rollback, stop/resume rollout, status (needs `github`) |
| `posthog` | analytics questions |

```json
{
  "allowedSlackUserId": "U0123456789",
  "autonomy": "none",
  "projects": [
    {
      "id": "mobile",
      "name": "My App",
      "slackChannels": ["my-app-releases"],
      "github": { "repo": "your-org/your-app", "releaseBranch": "release" },
      "expo": {
        "iosBundleId": "com.example.yourapp",
        "workflows": { "ota": "ota-production.yml", "testflight": "release-native.yml", "android": "build-android.yml" }
      }
    },
    {
      "id": "web",
      "name": "Website",
      "github": { "repo": "your-org/your-website" },
      "posthog": { "host": "https://eu.posthog.com", "projectId": "12345" }
    }
  ]
}
```

| Setting | Default | What it is |
|---|---|---|
| `allowedSlackUserId` | required | Slack member ID(s) Blink listens to |
| `autonomy` | `none` | `partial`: only releases need Confirm. `full`: nothing does. OpenAI's actions always do. |
| `retention.threadDays` / `.confirmMinutes` | `7` / `30` | How long threads are remembered and buttons stay clickable |
| `models.jev` / `models.openai` | `jev-1.13.0` / `gpt-6-luna` | Model versions |
| `projects[].id`, `name`, `aliases` | | How you refer to the project |
| `projects[].slackChannels` | | Channel names or IDs that belong to the project |
| `github.repo`, `github.releaseBranch` | `release` | `owner/repo` and the branch releases run from |
| `expo.iosBundleId` | required | Used to look up the live App Store version |
| `expo.otaChannel` | `production` | EAS Update channel |
| `expo.workflows.*` | | Workflow file names; `null` turns that command off |
| `expo.versioning` | `app-json` | `app-json`, `minor` (OTA updates count as the patch) or `none` |
| `expo.localBuild` | `false` | Build TestFlight on this Mac instead of EAS's cloud |
| `expo.installScripts` | `false` | Run dependencies' install scripts in Blink's clone |
| `posthog.host`, `posthog.projectId` | required | Your PostHog instance and project |

Blink picks a message's project from the channel, a project name in the message, the thread, or which project can do what you asked, and asks when it can't tell. It keeps a little state in `blink.state.json` so a restart picks up pending Confirm cards and runs it was following.

## Development

```sh
npm run dev        # restart on changes
npm run typecheck
npm test           # no credentials needed
```

Blink is a small core plus one module per **capability** (GitHub, Expo, PostHog) under `src/capabilities/`, implementing the interface in `src/capability.ts`. To add one, write a `Capability` and list it in `src/capabilities/index.ts`.

## Limitations

- The example OTA workflow publishes iOS only.
- No App Store submission (EAS has no job for it).
- One process per Slack workspace; state is a local JSON file.

## License

[MIT](LICENSE)
