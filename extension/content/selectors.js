// Every YouTube DOM selector the extension depends on lives here.
// When YouTube changes its layout, this is the only file that should need updating.
// Video IDs are always read from link hrefs (/watch?v= or /shorts/), never from class names.
'use strict';

window.FYTD_SELECTORS = Object.freeze({
  // <a> elements that wrap a video/Short thumbnail. A download button is added inside each.
  // Structural selectors (a video link that contains a thumbnail element) come first because they
  // survive YouTube's frequent class renames; class-based ones are kept as fallbacks.
  thumbnailAnchors: [
    'ytd-thumbnail a#thumbnail', // classic grid, search, playlists
    'a[href*="/watch?v="]:has(yt-thumbnail-view-model)', // 2025+ "lockup" cards: home, sidebar, subs
    'a[href^="/shorts/"]:has(yt-thumbnail-view-model)', // Shorts shelf
    'a.ytLockupViewModelContentImage',
    'a.yt-lockup-view-model__content-image',
    'a.yt-lockup-view-model-wiz__content-image',
    'a.reel-item-endpoint:has(img)',
    'ytd-video-preview a.ytdVideoPreviewMediaContainerLink', // hover preview that covers the thumbnail
    'ytd-video-preview a#media-container-link',
  ].join(','),

  // The hover preview has its own mute/captions buttons in the top-right corner.
  previewContainer: 'ytd-video-preview',

  // Anchors containing one of these are playlist/mix cards, not single videos: skip them.
  playlistMarker: 'yt-collections-stack, yt-collection-thumbnail-view-model, ytd-playlist-thumbnail',

  // Watch page: row with Like / Share. First match wins.
  watchActionBar: [
    'ytd-watch-metadata #top-level-buttons-computed',
    '#above-the-fold #top-level-buttons-computed',
    'ytd-video-primary-info-renderer #top-level-buttons-computed',
  ],
  // Fallback when none of the rows above exist: put the button in the Like button's row.
  watchLikeButton: 'ytd-watch-metadata segmented-like-dislike-button-view-model, ytd-watch-metadata like-button-view-model',

  // Shorts player: one renderer per Short, each with a vertical action bar. First match wins.
  shortsReel: 'ytd-reel-video-renderer',
  shortsActionBar: [
    'reel-action-bar-view-model',
    '#actions.ytd-reel-player-overlay-renderer',
    '#actions',
  ],
  // Our Shorts button is placed right after the share button when found.
  shortsShareButton: '#share-button, [aria-label="Share"]',
});
