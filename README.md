# Blink

**Ship an Expo app from Slack.** @mention Blink in plain language, like _main to release_, _release to TestFlight_ or _roll back the OTA_, and it merges branches, publishes OTA updates, uploads iOS builds to TestFlight, and follows them until they finish.

Under the hood it pairs two kinds of model:

- **[Jev](https://docs.typesafe.ai/introduction)** (TypeSafe AI) handles every message. Jev doesn't write text: it answers typed questions ("which command is this?", "which of these branches is the source?") with probabilities, in about half a second, for a fraction of a cent. The bot turns its answers into actions and fixed reply templates.
- **OpenAI** is an optional fallback. When Jev can't make sense of a message, the bot offers an **Ask OpenAI** button. OpenAI gets the same commands as tools, so it can handle odd phrasing or answer a question, but it's only called when you click.

Nothing with side effects runs without a **Confirm** click, whichever model proposed it.

## Contents
- [What you can ask](#what-you-can-ask)
- [Safety model](#safety-model)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [Configuration](#configuration)
- [Development](#development)
- [Limitations](#limitations)

## What you can ask

| Ask for | Example | What happens (after Confirm) |
|---|---|---|
| **Merge** | _merge main into release_, _main to release_ | Opens a PR and merges it if there are no conflicts. Otherwise it leaves the PR open and sends you the link. |
| **OTA update** | _release an OTA_, _push an ota "fix the stars animation"_ | Publishes an iOS update from the release branch to the `production` channel. Quoted text becomes the update message. |
| **TestFlight** | _release to TestFlight_, _ship 4.1.0 to TestFlight_ | Bumps the version if needed (see [Versioning](#versioning)), then builds iOS and uploads it to App Store Connect. |
| **Roll back the OTA** | _roll back the OTA_, _undo the last update_ | Republishes the previous production update with the same runtime, or rolls back to the code inside the store build. |
| **Stop rollout** | _stop rollout_, _pause the OTA_ | Cancels a running OTA workflow before it publishes and pauses the `production` channel, so phones that don't have the update yet won't get it. |
| **Resume rollout** | _resume rollout_ | Unpauses the `production` channel. |
| **Status** | _status_, _how did the last build go?_ | The latest workflow run: result, failed step, version, duration, link, and whether `production` is paused. |
| **App Store release** | _submit to the App Store_ | Not supported (yet). The bot says so and offers TestFlight. |

- Follow-ups in a thread don't need another @mention (_merge main_ → _into release_).
- After an OTA or TestFlight release starts, the bot checks the run every 30 seconds and posts ✅ or ❌ in the thread, mentioning you.
- While it's working, your message gets a ⏳ reaction, and a ❌ if something fails unexpectedly.

## Safety model

- **One user.** The bot ignores everyone except `allowedSlackUserId`.
- **Confirm before acting.** Merges, releases, rollbacks and pauses are posted as Confirm / Cancel cards that expire after 30 minutes. Neither model can run anything itself.
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

**Starting EAS workflows.** The bot keeps its own clone of your app repo in `.repo/`. Before every run it resets the clone to the release branch on GitHub, then runs `eas workflow:run`, which uploads the project. This works even when the Expo project can't be linked to the GitHub repo (for example, a personal Expo account with an organization's repo).

### Versioning
Apple only accepts a build whose version is above the live App Store version **and** above any version it has already approved. Approved builds that never went live don't appear on the public App Store page, so the bot also checks EAS's build history.

- **No version given:** it keeps the version in `app.json` if that's allowed, otherwise proposes the next patch above the highest known version.
- **Version given:** it uses that, or refuses with the reason if it's too low.
- **On Confirm:** it commits the bump to the release branch, starts the build, then opens a PR bumping `main` too.

## Requirements

- **Node.js 22+**
- **An Expo app** using EAS Build, plus EAS Update with the `fingerprint` runtime policy and a `production` channel.
- **Two EAS workflows in the app repo** (examples below): `.eas/workflows/ota-production.yml` and `.eas/workflows/release-native.yml`.
- **A Slack workspace** where you can create an app.
- **Accounts:**
  - a TypeSafe AI key for Jev (Jev is in limited early access)
  - an Expo access token (a robot token is best)
  - GitHub access to the app repo (the `gh` CLI login or a token)
  - optionally, an OpenAI key for the fallback

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

## Setup

1. **Create the Slack app.** At https://api.slack.com/apps, choose *Create New App → From a manifest* and paste [`slack-app-manifest.yml`](slack-app-manifest.yml).
   - *Basic Information → App-Level Tokens*: create one with `connections:write`. That's `SLACK_APP_TOKEN`.
   - *Install App*: install it, then copy the *Bot User OAuth Token*. That's `SLACK_BOT_TOKEN`.
   - Invite the bot to a channel (`/invite @blink`).
   - If you change permissions later, reinstall the app so the token picks them up.
2. **Configure:** copy the two templates and fill them in (see [Configuration](#configuration)):
   ```sh
   cp .env.example .env                                         # secrets
   cp release-bot.config.example.json release-bot.config.json   # settings
   ```
3. **Run:** `npm install && npm start`

The bot uses Slack's Socket Mode, so it needs no public URL. The first release clones your app repo and installs its packages, so it takes a few minutes; later runs only re-sync.

## Configuration

Secrets and settings live in separate files, so the settings file can be shared or pasted into an issue without leaking anything. Both are gitignored; the `.example` versions are committed.

**`.env`: secrets**

| Variable | Required | What it is |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | yes | From the Slack app (above) |
| `TYPESAFE_API_KEY` | yes | From https://console.typesafe.ai/keys |
| `EXPO_TOKEN` | yes | Expo access token with access to your project |
| `OPENAI_API_KEY` | no | Enables the Ask OpenAI fallback |
| `GITHUB_TOKEN` | no | Defaults to your `gh` CLI login |

**`release-bot.config.json`: settings**

```json
{
  "appName": "your-app",
  "githubRepo": "your-org/your-app",
  "iosBundleId": "com.example.yourapp",
  "allowedSlackUserId": "U0123456789",
  "releaseBranch": "release",
  "otaChannel": "production",
  "workflows": { "ota": "ota-production.yml", "testflight": "release-native.yml" },
  "models": { "jev": "jev-1.13.0", "openai": "gpt-6-luna" }
}
```

| Setting | Required | What it is |
|---|---|---|
| `appName` | yes | Your app's name, used in messages to OpenAI |
| `githubRepo` | yes | `owner/repo` of your app |
| `iosBundleId` | yes | Used to look up the live App Store version |
| `allowedSlackUserId` | yes | The only Slack user the bot listens to (profile → ⋯ → Copy member ID) |
| `releaseBranch` | no | Branch all releases run from. Default `release` |
| `otaChannel` | no | EAS Update channel for OTA, rollback and pause. Default `production` |
| `workflows.ota`, `workflows.testflight` | no | Workflow file names in `.eas/workflows/`. Defaults as above |
| `models.jev` | no | Default `jev-1.13.0`. Pinned, because the confidence threshold is tuned per model. |
| `models.openai` | no | Default `gpt-6-luna` |
| `repoDir` | no | Where the bot keeps its clone of your app. Default `./.repo` |

The bot checks the file on startup and tells you exactly what's missing or malformed. To use a different path, set `RELEASE_BOT_CONFIG`.

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
| `src/replies.ts` | Reply templates |
| `src/actions.ts` | What each confirmed action does |
| `src/versioning.ts`, `src/version.ts` | Version rules, and fetching the live and built versions |
| `src/ota.ts` | OTA controls: pause/resume, cancel a publish, roll back |
| `src/watch.ts` | Follows a started workflow run and reports when it finishes |
| `src/expo.ts`, `src/repo.ts` | EAS CLI calls and the bot's clone of the app repo |
| `src/github.ts` | GitHub API: branches, PRs, merges, file commits |
| `src/config.ts` | Loads secrets from `.env` and settings from `release-bot.config.json` |

## Limitations

- **iOS only.**
- **No App Store submission.** EAS has no job for submitting a version to App Store review.
- **Single user, in-memory state.** Threads, pending confirmations and run watches reset when the bot restarts.
- **The bot only runs while `npm start` is running.** Host it somewhere always-on if you need that.
- **`eas workflow:validate`** currently crashes on every workflow, because of a mismatch between Expo's published schema and `eas-cli`. Running workflows isn't affected.

## License

[MIT](LICENSE)
