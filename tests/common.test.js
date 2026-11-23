// Run: node --test tests/common.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../extension/lib/common.js');

const ID = 'dQw4w9WgXcQ';

test('parseVideoId accepts every supported link shape', () => {
  const links = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `https://www.youtube.com/watch?v=${ID}&list=PLabc&index=3`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=10`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `youtu.be/${ID}`,
    `  https://youtu.be/${ID}  `,
    ID,
  ];
  for (const link of links) assert.equal(F.parseVideoId(link), ID, link);
});

test('parseVideoId resolves relative thumbnail hrefs', () => {
  assert.equal(F.parseVideoId(`/watch?v=${ID}&pp=xyz`, 'https://www.youtube.com'), ID);
  assert.equal(F.parseVideoId(`/shorts/${ID}`, 'https://www.youtube.com'), ID);
  assert.equal(F.parseVideoId('/@somechannel', 'https://www.youtube.com'), null);
});

test('parseVideoId rejects non-video and foreign links', () => {
  const bad = [
    '', '   ', 'hello', 'https://www.youtube.com/', 'https://www.youtube.com/playlist?list=PLabc',
    'https://www.youtube.com/@channel', 'https://www.youtube.com/watch?v=short', `https://evil.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`, `javascript:alert(1)//youtu.be/${ID}`, `ftp://youtu.be/${ID}`,
    null, undefined, 42,
  ];
  for (const link of bad) assert.equal(F.parseVideoId(link), null, String(link));
});

test('formatBytes shows exact and approximate sizes', () => {
  assert.equal(F.formatBytes(48_234_567, false), '48.2 MB');
  assert.equal(F.formatBytes(48_234_567, true), '~48 MB');
  assert.equal(F.formatBytes(4_820_000, true), '~4.8 MB');
  assert.equal(F.formatBytes(1_500_000_000, false), '1.5 GB');
  assert.equal(F.formatBytes(null, true), 'size unknown');
});

test('formatDuration', () => {
  assert.equal(F.formatDuration(65), '1:05');
  assert.equal(F.formatDuration(3723), '1:02:03');
  assert.equal(F.formatDuration(undefined), '');
});

test('pickDefault picks the closest quality at or below the preference, MP4 first', () => {
  const v = (height, ext) => ({ kind: 'video', height, ext, label: `${height}p` });
  const options = [v(2160, 'webm'), v(1080, 'mp4'), v(1080, 'webm'), v(720, 'mp4'), v(360, 'mp4'),
    { kind: 'audio', ext: 'm4a' }, { kind: 'audio', ext: 'mp3' }];
  assert.equal(F.pickDefault(options, '1080'), options[1]);
  assert.equal(F.pickDefault(options, '1440'), options[1]);
  assert.equal(F.pickDefault(options, 'best'), options[0]);
  assert.equal(F.pickDefault(options, '480'), options[4]);
  assert.equal(F.pickDefault(options, '240'), options[4]); // nothing that small: lowest available
  assert.equal(F.pickDefault(options, 'mp3'), options[6]);
  assert.equal(F.pickDefault([], '1080'), null);
});

test('statusText', () => {
  assert.equal(F.statusText({ status: 'downloading', percent: 41.6, speed: 2_100_000, eta: 75 }), '42% · 2.1 MB/s · 1:15 left');
  assert.equal(F.statusText({ status: 'processing', stage: 'ExtractAudio' }), 'Converting to MP3…');
  assert.equal(F.statusText({ status: 'error', error: 'This video is private.' }), 'This video is private.');
});
