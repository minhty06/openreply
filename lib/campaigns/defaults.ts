/**
 * Default campaign copy, in one place.
 *
 * These strings were previously duplicated across the builder and three
 * separate send paths in the DM worker, which had already drifted: the follow
 * prompt existed in two different wordings and its button label in two
 * different capitalisations, so the same campaign said different things
 * depending on whether the trigger was a comment or a DM.
 *
 * This module must import nothing. The builder is a client component, and both
 * of its sibling modules (`duplicate.ts`, `links.ts`) reach for Prisma, so
 * importing either from the client would pull the database client into the
 * browser bundle.
 *
 * None of this is wrapped in `t()` on purpose. Per lib/i18n/index.ts, only
 * application-owned chrome belongs in the translation table; campaign messages
 * are the operator's own voice and are stored per campaign.
 */

/**
 * Seeded into a new campaign's public-reply list. One is picked at random per
 * send, so several short variations keep the replies under a post from looking
 * copy-pasted.
 *
 * Mutable `string[]` rather than `readonly string[]`: the builder holds this in
 * `useState<string[]>` and spreads/filters it. Always seed state with a copy
 * (`[...DEFAULT_PUBLIC_REPLY_MESSAGES]`) so component state never aliases this
 * module-level array.
 */
export const DEFAULT_PUBLIC_REPLY_MESSAGES: string[] = [
  "sending it over :)",
  "Done! Check your DMs",
  "sent! ᕙ( •̀ ᗜ •́ )ᕗ",
];

/**
 * First follow-gate prompt, and the fallback when a campaign stored none.
 */
export const FOLLOW_PROMPT_PRESET =
  "quick favor before i send your link. i don't make any money from this, " +
  "it's free. if you want to support me so i can keep creating these " +
  "resources, please consider giving me a follow, i'll send you the " +
  "resource right after :)";

/**
 * The one nudge when a tap on "i'm following" cannot see the follow.
 * Instagram's follow status lags a fresh follow by a few seconds, so the
 * likeliest explanation is an honest follower rather than a chancer, and the
 * copy says so instead of accusing them. It asks for another tap now rather
 * than telling them to wait: the next miss gives up and sends the link.
 */
export const FOLLOW_PROMPT_RETRY =
  "instagram can take a few seconds to register a new follow. here's my " +
  "profile if you need it. tap the button again and i'll send your link " +
  "right over";

/**
 * Sent with the link once someone has made FOLLOW_GATE_GRACE_AFTER honest
 * attempts. Nobody should be able to get permanently stuck behind a status
 * check they cannot influence, so the gate gives up rather than trap them.
 */
export const FOLLOW_PROMPT_GRACE =
  "sending it anyway :) if you did follow, thank you. it genuinely helps " +
  "me keep making these";

export const DEFAULT_FOLLOW_PROMPT_BUTTON_LABEL = "i'm following";
export const DEFAULT_FOLLOW_PROFILE_BUTTON_LABEL = "follow me";
export const DEFAULT_LINK_BUTTON_LABEL = "Open link";
