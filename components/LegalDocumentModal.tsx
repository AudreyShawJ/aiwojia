import { colors } from '@/constants/designTokens';
import {
  PRIVACY_POLICY_BLOCKS,
  TERMS_OF_SERVICE_BLOCKS,
  type LegalBlock,
} from '@/constants/legalDocuments';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export type LegalDocKind = 'privacy' | 'terms';

function LegalBlocksView({ blocks }: { blocks: LegalBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'title') {
          return (
            <Text key={i} style={s.docTitle}>
              {b.text}
            </Text>
          );
        }
        if (b.type === 'intro') {
          return (
            <Text key={i} style={s.intro}>
              {b.text}
            </Text>
          );
        }
        if (b.type === 'section') {
          return (
            <Text key={i} style={s.sectionTitle}>
              {b.title}
            </Text>
          );
        }
        if (b.type === 'p') {
          return (
            <Text key={i} style={s.paragraph}>
              {b.text}
            </Text>
          );
        }
        if (b.type === 'bullets') {
          return (
            <View key={i} style={s.listWrap}>
              {b.items.map((line, j) => (
                <View key={j} style={s.bulletRow}>
                  <Text style={s.bulletDot}>•</Text>
                  <Text style={s.bulletText}>{line}</Text>
                </View>
              ))}
            </View>
          );
        }
        if (b.type === 'numbered') {
          return (
            <View key={i} style={s.listWrap}>
              {b.items.map((line, j) => (
                <View key={j} style={s.numberRow}>
                  <Text style={s.numberIdx}>{j + 1}.</Text>
                  <Text style={s.numberText}>{line}</Text>
                </View>
              ))}
            </View>
          );
        }
        return null;
      })}
    </>
  );
}

type Props = {
  open: LegalDocKind | null;
  onClose: () => void;
};

export function LegalDocumentModal({ open, onClose }: Props) {
  return (
    <Modal
      visible={open !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}>
      <SafeAreaView style={s.modalSafe} edges={['top', 'bottom']}>
        <View style={s.modalHeader}>
          <Text style={s.modalHeaderTitle}>
            {open === 'privacy' ? '隐私政策' : open === 'terms' ? '用户服务协议' : ''}
          </Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [s.modalClose, pressed && { opacity: 0.7 }]}>
            <Text style={s.modalCloseText}>关闭</Text>
          </Pressable>
        </View>
        <ScrollView
          style={s.modalScroll}
          contentContainerStyle={s.modalScrollContent}
          showsVerticalScrollIndicator>
          {open === 'privacy' ? (
            <LegalBlocksView blocks={PRIVACY_POLICY_BLOCKS} />
          ) : open === 'terms' ? (
            <LegalBlocksView blocks={TERMS_OF_SERVICE_BLOCKS} />
          ) : null}
          <View style={{ height: 32 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  modalSafe: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  modalHeaderTitle: { fontSize: 17, fontWeight: '600', color: colors.foreground },
  modalClose: { paddingVertical: 6, paddingHorizontal: 4 },
  modalCloseText: { fontSize: 16, color: colors.primary, fontWeight: '500' },
  modalScroll: { flex: 1 },
  modalScrollContent: { paddingHorizontal: 22, paddingTop: 20 },
  docTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 16,
    letterSpacing: 0.5,
  },
  intro: {
    fontSize: 15,
    lineHeight: 24,
    color: colors.foreground,
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: 8,
    marginBottom: 10,
  },
  paragraph: {
    fontSize: 14,
    lineHeight: 22,
    color: colors.foreground,
    marginBottom: 10,
  },
  listWrap: { marginBottom: 12, paddingLeft: 2 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  bulletDot: {
    fontSize: 14,
    color: colors.primary,
    width: 18,
    lineHeight: 22,
    marginTop: 0,
  },
  bulletText: { flex: 1, fontSize: 14, lineHeight: 22, color: colors.foreground },
  numberRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  numberIdx: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.mutedForeground,
    width: 22,
    lineHeight: 22,
  },
  numberText: { flex: 1, fontSize: 14, lineHeight: 22, color: colors.foreground },
});
