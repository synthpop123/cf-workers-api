# memos

Loaded with the files in this directory; the root `AGENTS.md` has the rules that hold everywhere.

- The latest `MEMOS` public statuses, boosts and replies excluded, from
  the self-hosted Mastodon (`MASTODON_URL`, `MASTODON_ACCOUNT`), narrowed
  in `services/memos/mastodon.ts`. The status HTML ships as Mastodon
  renders it; the page's allow-list sanitizer owns it. Everything else on
  a status (account, application, mentions, counts) is never typed.
- Photos are copied as WebP at 640 and 1600 wide, scaled down with their
  ratio kept (`services/memos/media.ts`), keyed by attachment id and
  width. The previous stored body stands for the copies that exist, so
  a run asks R2 about new attachments only, and copies at most `MAX_NEW`
  of them; one that waits is served from the instance meanwhile (it is
  self-hosted, like Koito). Video, gifv and audio stream from the
  instance: the Images binding transforms stills only.
- Alt text ships as the attachment's own description or null; the page
  falls back to the memo's words, never to words behind a warning.
