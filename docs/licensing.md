# Licensing — what is unresolved

Two things about this repo's terms are unsettled. Neither blocks anything
day to day; both matter because the repo is public.

## The licence contradicts itself

- `README.md` says "All rights reserved"
- `src/components/About.tsx` says "Licensed under GPL-3.0-or-later"
- `CITATION.cff` says `license: GPL-3.0-or-later`

A reader has no way to tell which governs, and the app itself tells them
something the README denies. Pick one and make all three agree. Whatever is
chosen now, versions already published under GPL-3.0 stay under it — that
grant cannot be withdrawn from anyone who already has them.

## The 360mash filters

The image filters are ports of 360mash shaders. 360mash is marked
`"license": "UNLICENSED", "private": true` and belongs to Big Soft Video /
Aalborg University. Redistributing the ports needs the say-so of whoever
holds those rights, independently of what licence this repo declares.
`THIRD-PARTY.md` records the provenance; it does not establish permission.

## If the source is ever taken private again

The releases would have to move, because a private repo's Releases are
private too — only collaborators can download them. Commit `ba458ab` has a
working two-repo setup: build in the private repo, push artifacts to a
public one with `gh release upload --repo`, driven by a fine-grained PAT in
a `BUILDS_TOKEN` secret. `codeslayer84/BubbleCut_public` already exists for
that purpose and carries the downloads page.
