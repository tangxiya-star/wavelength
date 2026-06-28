import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Dimensions, FlatList, type LayoutChangeEvent, Platform, StyleSheet, useWindowDimensions, View, type ViewToken } from 'react-native';
import { VideoFeedItem } from '../components/VideoFeedItem';
import { api } from '../lib/api';
import { shuffleWithSeed } from '../lib/catalog';
import { events } from '../lib/events';
import { useSession } from '../lib/session';
import { colors } from '../lib/theme';
import type { Video } from '../lib/types';

const CREATOR_GAP = 3;
// Guarantee at least one B2B (sponsor) clip within every B2B_INTERVAL videos.
const B2B_INTERVAL = 10;

function isB2B(video: Video) {
  return video.contentType === 'b2b';
}

/**
 * Weave sponsor (B2B) clips into a run of regular videos so at least one B2B
 * appears within every B2B_INTERVAL videos. `state` carries the running counter
 * and the sponsor rotation across appended rounds, so the cadence stays exact
 * across the endless feed and sponsors cycle (rather than repeating).
 */
function interleaveB2B(regular: Video[], b2b: Video[], state: { sinceB2B: number; rotation: number }): Video[] {
  if (b2b.length === 0) return regular;
  const out: Video[] = [];
  for (const video of regular) {
    out.push(video);
    state.sinceB2B += 1;
    // After B2B_INTERVAL-1 regulars, drop a sponsor → one per 10-video window.
    if (state.sinceB2B >= B2B_INTERVAL - 1) {
      out.push(b2b[state.rotation % b2b.length]);
      state.rotation += 1;
      state.sinceB2B = 0;
    }
  }
  return out;
}

function creatorKey(video: Video) {
  if (video.slug && video.id && video.slug.endsWith(`_${video.id}`)) {
    return video.slug.slice(0, -(video.id.length + 1));
  }
  const parts = video.slug.split('_');
  return parts.length > 2 ? parts.slice(0, -1).join('_') : video.contentType || video.slug || video.id;
}

function isTooCloseToSameCreator(candidate: Video, ordered: Video[]) {
  const key = creatorKey(candidate);
  return ordered.slice(-CREATOR_GAP).some((video) => creatorKey(video) === key);
}

function spaceCreators(items: Video[], carry: Video[] = []) {
  const remaining = [...items];
  const ordered: Video[] = [];
  const context = carry.slice(-CREATOR_GAP);

  while (remaining.length) {
    const recent = [...context, ...ordered];
    const nextIndex = remaining.findIndex((video) => !isTooCloseToSameCreator(video, recent));
    ordered.push(remaining.splice(nextIndex >= 0 ? nextIndex : 0, 1)[0]);
  }

  return ordered;
}

export default function FeedScreen() {
  const { status, session, markVideoViewed } = useSession();
  const { width: winW } = useWindowDimensions();
  const [playlist, setPlaylist] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [height, setHeight] = useState(Dimensions.get('window').height);
  // Videos always play un-muted; the mute toggle was removed (no audio control UI).
  const muted = false;

  // Base pool (regular videos only) + round counter for the infinite,
  // re-randomised feed. Sponsor (B2B) clips are kept apart and re-injected on
  // every round so the "one per 10" cadence survives the endless recycling.
  const basePoolRef = useRef<Video[]>([]);
  const b2bPoolRef = useRef<Video[]>([]);
  const b2bStateRef = useRef({ sinceB2B: 0, rotation: 0 });
  const roundsRef = useRef(1);
  const recentTailRef = useRef<Video[]>([]);

  // Imperative handle + keyboard target index for arrow-key navigation (web demo).
  const listRef = useRef<FlatList<Video>>(null);
  const targetIndexRef = useRef(0);


  // On wide screens (desktop web) constrain to a centered 9:16 column so the
  // portrait video shows in its true aspect instead of a stretched landscape crop.
  const isWide = Platform.OS === 'web' && winW >= 640;
  const colWidth = isWide ? Math.min(winW, Math.round(height * (9 / 16))) : winW;

  // Web only: make expo-video's <video> fill its container (it otherwise renders
  // at intrinsic px size), and keep playback inline.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const id = 'fs-video-style';
    if (!document.getElementById(id)) {
      const s = document.createElement('style');
      s.id = id;
      // Size the <video> to its container, but do NOT force object-fit globally —
      // expo-video's per-item contentFit (cover vs contain) must win so b2b clips
      // letterbox (contain) while UGC fills the column (cover).
      s.textContent = 'video{width:100%!important;height:100%!important;background:#000;}';
      document.head.appendChild(s);
    }
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.querySelectorAll('video').forEach((v) => {
      v.setAttribute('playsinline', '');
      (v as HTMLVideoElement).playsInline = true;
    });
  }, [activeIndex, playlist]);

  // Redirect out when the (silent) session ends or was never started.
  useEffect(() => {
    if (status === 'ended') router.replace('/complete');
    else if (status === 'idle') router.replace('/');
  }, [status]);

  // Load the shuffled playlist for this session.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.getPlaylist(session.playlistSeed, session.condition);
        if (!cancelled) {
          // Pinned prefix: render first, in exact server order (no spaceCreators /
          // interleaveB2B), including the b2b at pinned position 3.
          const pinned = list.filter((v) => v.pinned);
          // Everything after the prefix flows through the existing endless machinery.
          const rest = list.filter((v) => !v.pinned);
          const restRegular = rest.filter((v) => !isB2B(v));
          basePoolRef.current = restRegular;
          b2bPoolRef.current = rest.filter(isB2B);
          b2bStateRef.current = { sinceB2B: 0, rotation: 0 };
          roundsRef.current = 1;
          const spacedRest = spaceCreators(restRegular);
          recentTailRef.current = spacedRest.slice(-CREATOR_GAP);
          const tail = interleaveB2B(spacedRest, b2bPoolRef.current, b2bStateRef.current);
          setPlaylist([...pinned, ...tail]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Sync analytics context + viewed set to the active card.
  useEffect(() => {
    const v = playlist[activeIndex];
    if (v) {
      events.setActiveVideo(v.id, activeIndex);
      markVideoViewed(v.id);
    }
  }, [activeIndex, playlist, markVideoViewed]);

  const onViewRef = useRef((info: { viewableItems: ViewToken[] }) => {
    const first = info.viewableItems.find((t) => t.isViewable);
    if (first?.index != null) setActiveIndex(first.index);
  });
  const viewConfigRef = useRef({ itemVisiblePercentThreshold: 80 });

  // Keep the arrow-key target aligned with the card the user is actually on, so
  // manual scrolling and key-nav stay in agreement.
  useEffect(() => {
    targetIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Web demo: ArrowDown advances exactly one video, ArrowUp goes back one.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const len = playlist.length;
      if (len === 0) return;
      e.preventDefault(); // don't also page-scroll the document
      const next = Math.max(0, Math.min(len - 1, targetIndexRef.current + (e.key === 'ArrowDown' ? 1 : -1)));
      if (next === targetIndexRef.current) return;
      targetIndexRef.current = next;
      listRef.current?.scrollToIndex({ index: next, animated: true });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [playlist.length]);

  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0 && Math.abs(h - height) > 1) setHeight(h);
  };

  // When the user reaches the end of the set, append a freshly shuffled round so
  // the feed never runs dry before the timer (a fallback for an engaged user).
  const appendRound = useCallback(() => {
    const pool = basePoolRef.current;
    if (!session || pool.length === 0) return;
    const seed = `${session.playlistSeed}:${roundsRef.current}`;
    roundsRef.current += 1;
    const spaced = spaceCreators(shuffleWithSeed(pool, seed), recentTailRef.current);
    recentTailRef.current = spaced.slice(-CREATOR_GAP);
    const next = interleaveB2B(spaced, b2bPoolRef.current, b2bStateRef.current);
    events.log('feed_recycled', { round: roundsRef.current - 1, creatorGap: CREATOR_GAP, b2bInterval: B2B_INTERVAL });
    setPlaylist((prev) => [...prev, ...next]);
  }, [session]);

  return (
    <View style={styles.root}>
      <View style={[styles.column, { width: colWidth }, isWide && styles.columnWide]} onLayout={onLayout}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={playlist}
            keyExtractor={(item, index) => `${item.id}-${index}`}
            renderItem={({ item, index }) => (
              <VideoFeedItem video={item} feedPosition={index} isActive={index === activeIndex} height={height} muted={muted} />
            )}
            pagingEnabled
            snapToInterval={height}
            snapToAlignment="start"
            decelerationRate="fast"
            showsVerticalScrollIndicator={false}
            getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
            onViewableItemsChanged={onViewRef.current}
            viewabilityConfig={viewConfigRef.current}
            windowSize={3}
            maxToRenderPerBatch={2}
            initialNumToRender={1}
            removeClippedSubviews
            onEndReached={appendRound}
            onEndReachedThreshold={0.6}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  column: { flex: 1, alignSelf: 'center', backgroundColor: colors.bg, position: 'relative', overflow: 'hidden' },
  columnWide: { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
