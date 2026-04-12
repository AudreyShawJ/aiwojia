import { colors } from '@/constants/designTokens';
import { LinearGradient } from 'expo-linear-gradient';
import { Mic, Send, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PRIMARY = colors.primary;
const ACCENT = colors.accent;

export interface VoiceInputModalProps {
  visible: boolean;
  transcript: string;
  /** 环境或权限原因无法启动识别时在框内展示 */
  environmentError?: string | null;
  isRecording: boolean;
  /** 录音中：点击麦克风停止录音并触发 ASR */
  onStopRecording?: () => void;
  /** 识别完成后：点击麦克风追加新一轮录音 */
  onReRecord?: () => void;
  onClose: () => void;
  onSend: () => void;
}

/** 语音输入全屏模态 */
export function VoiceInputModal({
  visible,
  transcript,
  environmentError = null,
  isRecording,
  onStopRecording,
  onReRecord,
  onClose,
  onSend,
}: VoiceInputModalProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const cardMaxW = Math.min(width - 48, 400);
  const [audioTick, setAudioTick] = useState(0);

  const pulse = useRef(new Animated.Value(1)).current;
  const ringOuter = useRef(new Animated.Value(1)).current;
  const ringInner = useRef(new Animated.Value(1)).current;
  const ringOuterOpacity = useRef(new Animated.Value(0)).current;
  const ringInnerOpacity = useRef(new Animated.Value(0)).current;

  const blocked = Boolean(environmentError);
  const waveActive = isRecording && !blocked;
  /** 识别完成、有结果、不在录音中 → 可追加录音 */
  const canReRecord = !isRecording && !blocked && Boolean(transcript && transcript !== '识别中…');

  useEffect(() => {
    if (!waveActive) {
      Animated.parallel([
        Animated.spring(pulse, { toValue: 1, useNativeDriver: true }),
        Animated.spring(ringOuter, { toValue: 1, useNativeDriver: true }),
        Animated.spring(ringInner, { toValue: 1, useNativeDriver: true }),
        Animated.timing(ringOuterOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(ringInnerOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(ringOuterOpacity, { toValue: 0.35, duration: 200, useNativeDriver: true }),
      Animated.timing(ringInnerOpacity, { toValue: 0.45, duration: 200, useNativeDriver: true }),
    ]).start();
    const loopPulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.05, duration: 750, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    const loopOuter = Animated.loop(
      Animated.sequence([
        Animated.timing(ringOuter, { toValue: 1.3, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(ringOuter, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    const loopInner = Animated.loop(
      Animated.sequence([
        Animated.timing(ringInner, { toValue: 1.2, duration: 750, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(ringInner, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loopPulse.start();
    loopOuter.start();
    loopInner.start();
    return () => {
      loopPulse.stop();
      loopOuter.stop();
      loopInner.stop();
    };
  }, [waveActive]);

  useEffect(() => {
    if (!waveActive) return;
    const id = setInterval(() => setAudioTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [waveActive]);

  const barHeights = useMemo(() => {
    const phase = audioTick * 0.4;
    return Array.from({ length: 20 }, (_, i) => {
      const h = Math.max(
        8,
        20 + (Math.sin((phase + i * 0.55) * 0.9) + 1) * 22 + Math.random() * 12
      );
      return h;
    });
  }, [audioTick]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      presentationStyle="overFullScreen"
      onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {/* 不用 Reanimated entering：在 Modal 内偶现透明度不更新，导致整层不可见 */}
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
            <View style={styles.backdrop} />
          </Pressable>
        </View>

        <View pointerEvents="box-none" style={styles.centerWrap}>
          <View style={[styles.cardWrap, { width: cardMaxW }]}>
            <View style={styles.card}>
              <LinearGradient
                colors={[PRIMARY, ACCENT]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.gradientHeader}>
                <Pressable
                  onPress={onClose}
                  hitSlop={12}
                  style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}>
                  <X size={20} color="#fff" strokeWidth={2} />
                </Pressable>

                <View style={styles.statusRow}>
                  <View style={styles.statusPill}>
                    <View style={styles.statusDot} />
                    <Text style={styles.statusText}>
                      {blocked
                        ? '暂不可用'
                        : isRecording
                        ? '录音中，点击停止'
                        : transcript === '识别中…'
                        ? '识别中…'
                        : canReRecord
                        ? '点击麦克风继续追加'
                        : '准备就绪'}
                    </Text>
                  </View>
                </View>

                <View style={styles.micArea}>
                  <View style={styles.micRings}>
                    <Animated.View style={[styles.ringOuter, { opacity: ringOuterOpacity, transform: [{ scale: ringOuter }] }]} />
                    <Animated.View style={[styles.ringInner, { opacity: ringInnerOpacity, transform: [{ scale: ringInner }] }]} />
                    <Pressable
                      onPress={
                        isRecording && onStopRecording
                          ? onStopRecording
                          : canReRecord && onReRecord
                          ? onReRecord
                          : undefined
                      }
                      hitSlop={8}>
                      <Animated.View style={[
                        styles.micCircle,
                        canReRecord && styles.micCircleReRecord,
                        { transform: [{ scale: pulse }] },
                      ]}>
                        <Mic size={44} color={canReRecord ? '#fff' : PRIMARY} strokeWidth={2} />
                      </Animated.View>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.waveRow}>
                  {barHeights.map((h, i) => (
                    <View
                      key={i}
                      style={[
                        styles.waveBar,
                        {
                          height: waveActive ? h : 8,
                        },
                      ]}
                    />
                  ))}
                </View>
              </LinearGradient>

              <View style={styles.body}>
                <Text style={styles.sectionLabel}>识别内容</Text>
                <View style={styles.transcriptBox}>
                  <ScrollView
                    keyboardShouldPersistTaps="handled"
                    style={styles.transcriptScroll}
                    contentContainerStyle={styles.transcriptScrollContent}>
                    {environmentError ? (
                      <Text style={styles.transcriptError}>{environmentError}</Text>
                    ) : transcript ? (
                      <Text style={styles.transcriptText}>{transcript}</Text>
                    ) : (
                      <Text style={styles.transcriptPlaceholder}>请开始说话…</Text>
                    )}
                  </ScrollView>
                </View>

                <View style={styles.footerBtns}>
                  <Pressable
                    onPress={onClose}
                    style={({ pressed }) => [styles.btnCancel, pressed && styles.btnPressed]}>
                    <Text style={styles.btnCancelText}>取消</Text>
                  </Pressable>
                  <Pressable
                    onPress={onSend}
                    disabled={!transcript.trim() || blocked}
                    style={({ pressed }) => [
                      styles.btnSend,
                      (!transcript.trim() || blocked) && styles.btnSendDisabled,
                      pressed && transcript.trim() && !blocked && styles.btnPressed,
                    ]}>
                    <LinearGradient
                      colors={[PRIMARY, ACCENT]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={styles.btnSendGradient}>
                      <Send size={20} color="#fff" strokeWidth={2} />
                      <Text style={styles.btnSendText}>发送</Text>
                    </LinearGradient>
                  </Pressable>
                </View>
              </View>
            </View>

            <Text style={styles.hint}>
              {blocked
                ? '请检查麦克风权限或网络连接'
                : isRecording
                ? '录音中…点击麦克风停止并识别'
                : canReRecord
                ? '可继续点击麦克风追加录音，或点击发送'
                : '识别完成后可点击发送填入输入框'}
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  centerWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    zIndex: 1,
  },
  cardWrap: {
    alignSelf: 'center',
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 32,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 16,
  },
  gradientHeader: {
    paddingHorizontal: 32,
    paddingTop: 48,
    paddingBottom: 28,
  },
  closeBtn: {
    position: 'absolute',
    top: 22,
    right: 22,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnPressed: {
    opacity: 0.85,
  },
  statusRow: {
    alignItems: 'center',
    marginBottom: 28,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fff',
  },
  statusText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  micArea: {
    alignItems: 'center',
    marginBottom: 28,
  },
  micRings: {
    width: 180,
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringOuter: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  ringInner: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  micCircle: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
  micCircleReRecord: {
    backgroundColor: PRIMARY,
  },
  waveRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 5,
    height: 64,
  },
  waveBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.62)',
  },
  body: {
    paddingHorizontal: 32,
    paddingTop: 28,
    paddingBottom: 28,
  },
  sectionLabel: {
    fontSize: 13,
    color: colors.mutedForeground,
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  transcriptBox: {
    minHeight: 88,
    maxHeight: 160,
    backgroundColor: 'rgba(240,241,243,0.85)',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(31,31,31,0.08)',
    marginBottom: 22,
  },
  transcriptScroll: {
    maxHeight: 132,
  },
  transcriptScrollContent: {
    flexGrow: 1,
  },
  transcriptText: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.foreground,
  },
  transcriptPlaceholder: {
    fontSize: 15,
    fontStyle: 'italic',
    color: 'rgba(142,142,147,0.65)',
  },
  transcriptError: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.destructive,
  },
  footerBtns: {
    flexDirection: 'row',
    gap: 10,
  },
  btnCancel: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 18,
    backgroundColor: 'rgba(240,241,243,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
  btnSend: {
    flex: 1,
    borderRadius: 18,
    overflow: 'hidden',
  },
  btnSendDisabled: {
    opacity: 0.42,
  },
  btnSendGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
  },
  btnSendText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  btnPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.98 }],
  },
  hint: {
    textAlign: 'center',
    marginTop: 22,
    fontSize: 13,
    color: 'rgba(255,255,255,0.82)',
    lineHeight: 18,
  },
});
