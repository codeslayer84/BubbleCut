# Making the source private, keeping the builds public

The source repo goes private; a second, public repo carries nothing but
release artifacts, so a download link can be shared without the code. CI
builds here and uploads there.

Everything below needs a GitHub account, and two of the steps involve a
token — do those yourself, they are not things to paste into a chat.

## 1. Create the public builds repo

New repo, **public**, named `bubblecut-builds` under the same account, and
**initialise it with a README** — an empty repo has no default branch, and
creating a release against a tag that does not exist needs one.

Replace its README with `docs/builds-repo-README.md` from this repo.

If you name it something else, change `BUILDS_REPO` at the top of
`.github/workflows/release.yml` to match.

## 2. Make a token for it

github.com → Settings → Developer settings → **Fine-grained tokens** →
Generate new token.

- Repository access: **Only select repositories** → `bubblecut-builds`
- Permissions: **Contents: Read and write** (nothing else)
- Expiry: whatever you are willing to renew

## 3. Add it as a secret here

In the **BubbleCut** repo: Settings → Secrets and variables → Actions → New
repository secret, named `BUILDS_TOKEN`.

The workflow checks for it before building, so a missing token fails in
seconds rather than after a twenty-minute matrix build.

## 4. Flip this repo to private

Settings → General → Danger Zone → Change visibility → Make private.

## What that does and does not do

It stops new people getting the source. It does not retract what is already
out:

- GPL-3.0 grants on versions already published are irrevocable. Anyone who
  cloned them keeps the right to use and redistribute those versions.
- GitHub splits existing public forks into their own network when a repo goes
  private. Those forks stay public.
- Existing release download links on this repo stop working, so anyone you
  sent one to will need the new location.

## Still open

**The licence is inconsistent and now contradictory.** `README.md` says
"All rights reserved", while `About.tsx` and `CITATION.cff` say
GPL-3.0-or-later. Shipping a binary that claims GPL-3.0 while withholding the
source is a promise the download cannot keep. Pick one and make all three
agree. Versions already released under GPL-3.0 stay that way whatever you
choose now.

**360mash provenance.** The image filters are ports of 360mash shaders, and
360mash is marked `"license": "UNLICENSED", "private": true`. Whatever the
licence here says, redistributing those needs the say-so of whoever holds the
rights at Big Soft Video / AAU. That question survives going private — it
just stops getting worse.
