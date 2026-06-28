// One full-screen, looping video page + action rail (SPEC §3.4, §4).
//
// Owns the full per-item analytics lifecycle: video_impression on activate,
// video_play_start on first frame, video_watch_progress heartbeats, video_loop
// on each replay, and scroll_away (with dwell / watch / pct / loops) when the
// user swipes off. Only the active item plays; others pause and reset.

import { useVideoPlayer, VideoView } from 'expo-video';
import { randomUUID } from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { events } from '../lib/events';
import { useSession } from '../lib/session';
import { colors, space } from '../lib/theme';
import type { Video } from '../lib/types';
import { ActionRail, type Thumb } from './ActionRail';
import { OptionsSheet } from './OptionsSheet';

const HEARTBEAT_MS = 3000;

interface Props {
  video: Video;
  feedPosition: number;
  isActive: boolean;
  height: number;
  muted: boolean;
}

export function VideoFeedItem({ video, feedPosition, isActive, height, muted }: Props) {
  const player = useVideoPlayer(video.source, (p) => {
    p.loop = true;
    p.muted = muted;
  });

  const { recordInteraction, endSession } = useSession();

  const [thumb, setThumb] = useState<Thumb>(null);
  const [saved, setSaved] = useState(false);
  const [paused, setPaused] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  // Mutable per-activation stats (read by the deactivation cleanup).
  const stats = useRef({ exposureId: '', activatedAt: 0, watchMs: 0, loops: 0, maxPos: 0, lastPos: 0, playStartLogged: false, lastHeartbeat: 0 });
  const thumbRef = useRef<Thumb>(null);
  const savedRef = useRef(false);

  const log = (type: Parameters<typeof events.log>[0], payload: Record<string, unknown> = {}) =>
    events.log(type, {
      exposureId: stats.current.exposureId,
      videoSlug: video.slug,
      videoTitle: video.title,
      contentType: video.contentType,
      durationSeconds: video.durationSeconds,
      ...payload,
      feedPosition,
    }, video.id);

  // Keep mute in sync.
  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);

  // Activation lifecycle: play + sample while active; on deactivate, report scroll_away.
  useEffect(() => {
    if (!isActive) {
      player.pause();
      player.currentTime = 0;
      return;
    }

    const exposureId = randomUUID();
    stats.current = { exposureId, activatedAt: Date.now(), watchMs: 0, loops: 0, maxPos: 0, lastPos: 0, playStartLogged: false, lastHeartbeat: Date.now() };
    setPaused(false);
    setThumb(null);
    setSaved(false);
    thumbRef.current = null;
    savedRef.current = false;
    player.currentTime = 0;
    player.play();
    events.setActiveVideo(video.id, feedPosition, exposureId);
    log('video_impression', {
      exposureStartedAtEpochMs: stats.current.activatedAt,
      exposureStartedAtIso: new Date(stats.current.activatedAt).toISOString(),
    });

    const interval = setInterval(() => {
      const s = stats.current;
      const t = player.currentTime ?? 0;
      const playing = player.playing;

      if (!s.playStartLogged && playing) {
        s.playStartLogged = true;
        log('video_play_start', { startupMs: Date.now() - s.activatedAt });
      }
      if (playing) {
        const delta = t - s.lastPos;
        if (delta > 0 && delta < 2) s.watchMs += delta * 1000;
        if (delta < -0.5) {
          s.loops += 1;
          log('video_loop', { loopCount: s.loops, positionMs: Math.round(t * 1000), watchMs: Math.round(s.watchMs) });
        }
        s.maxPos = Math.max(s.maxPos, t);
        if (Date.now() - s.lastHeartbeat >= HEARTBEAT_MS) {
          s.lastHeartbeat = Date.now();
          log('video_watch_progress', {
            positionMs: Math.round(t * 1000),
            cumulativeWatchMs: Math.round(s.watchMs),
            dwellMs: Date.now() - s.activatedAt,
            maxPositionMs: Math.round(s.maxPos * 1000),
          });
        }
      }
      s.lastPos = t;
    }, 500);

    return () => {
      clearInterval(interval);
      const s = stats.current;
      const dur = player.duration || video.durationSeconds || 1;
      const summary = {
        dwellMs: Date.now() - s.activatedAt,
        watchMs: Math.round(s.watchMs),
        pctWatched: Math.min(1, s.maxPos / dur),
        loops: s.loops,
        maxPositionMs: Math.round(s.maxPos * 1000),
        finalPositionMs: Math.round((player.currentTime ?? 0) * 1000),
        finalThumb: thumbRef.current,
        saved: savedRef.current,
      };
      log('video_exposure_end', summary);
      log('scroll_away', summary);
      player.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  const onTap = () => {
    const positionMs = Math.round((player.currentTime ?? 0) * 1000);
    const dwellMs = stats.current.activatedAt ? Date.now() - stats.current.activatedAt : 0;
    if (player.playing) {
      player.pause();
      setPaused(true);
      log('pause', { positionMs, dwellMs });
    } else {
      player.play();
      setPaused(false);
      log('resume', { positionMs, dwellMs });
    }
  };

  const onThumbUp = () => {
    const next = thumb === 'up' ? null : 'up';
    setThumb(next);
    thumbRef.current = next;
    log(next === 'up' ? 'thumbs_up' : 'thumbs_up_removed', {
      positionMs: Math.round((player.currentTime ?? 0) * 1000),
      dwellMs: stats.current.activatedAt ? Date.now() - stats.current.activatedAt : 0,
    });
    if (next === 'up') recordInteraction('like');
  };
  const onThumbDown = () => {
    const next = thumb === 'down' ? null : 'down';
    setThumb(next);
    thumbRef.current = next;
    log(next === 'down' ? 'thumbs_down' : 'thumbs_down_removed', {
      positionMs: Math.round((player.currentTime ?? 0) * 1000),
      dwellMs: stats.current.activatedAt ? Date.now() - stats.current.activatedAt : 0,
    });
    if (next === 'down') recordInteraction('dislike');
  };
  const onSave = () => {
    const next = !saved;
    setSaved(next);
    savedRef.current = next;
    log(next ? 'save' : 'unsave', {
      positionMs: Math.round((player.currentTime ?? 0) * 1000),
      dwellMs: stats.current.activatedAt ? Date.now() - stats.current.activatedAt : 0,
    });
    if (next) recordInteraction('save');
  };
  const onOptions = () => {
    log('options_open', {
      positionMs: Math.round((player.currentTime ?? 0) * 1000),
      dwellMs: stats.current.activatedAt ? Date.now() - stats.current.activatedAt : 0,
    });
    setOptionsOpen(true);
  };

  return (
    <View style={[styles.page, { height }]}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit={video.contentType === 'b2b' ? 'contain' : 'cover'}
        nativeControls={false}
      />

      <Pressable style={StyleSheet.absoluteFill} onPress={onTap} />

      {paused && (
        <View pointerEvents="none" style={styles.pausedBadge}>
          <Text style={styles.pausedGlyph}>▶</Text>
        </View>
      )}

      <View style={styles.rail}>
        <ActionRail
          thumb={thumb}
          saved={saved}
          onThumbUp={onThumbUp}
          onThumbDown={onThumbDown}
          onSave={onSave}
          onOptions={onOptions}
        />
      </View>

      <OptionsSheet
        visible={optionsOpen}
        video={video}
        feedPosition={feedPosition}
        onClose={() => setOptionsOpen(false)}
        onEndSession={() => endSession('manual')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    width: '100%',
    backgroundColor: colors.bg,
    justifyContent: 'flex-end',
  },
  rail: {
    position: 'absolute',
    right: space.md,
    bottom: 120,
  },
  pausedBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pausedGlyph: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 64,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 8,
  },
});
