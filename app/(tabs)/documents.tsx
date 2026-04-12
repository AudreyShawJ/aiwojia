import { colors } from '@/constants/designTokens';
import { supabase } from '@/lib/supabase';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type DocItem = {
  id: string;
  title: string;
  doc_type: string;
  file_url: string;
  related_member: string | null;
  created_at: string;
};

const docTypeLabel: Record<string, string> = {
  image: '📷 图片',
  pdf: '📄 PDF',
  other: '📎 文件',
};

const formatDate = (dateStr: string) => {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(dateStr))
    .reduce<Record<string, string>>((acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; }, {});
  return `${parseInt(parts.month ?? '1', 10)}月${parseInt(parts.day ?? '1', 10)}日`;
};

export default function DocumentsScreen() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const loadDocs = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id;
    if (!uid) return;
    setUserId(uid);

    const { data: userData } = await supabase
      .from('users')
      .select('family_id')
      .eq('id', uid)
      .single();

    const fid = userData?.family_id;
    if (!fid) { setDocs([]); return; }
    setFamilyId(fid);

    const { data, error } = await supabase
      .from('documents')
      .select('id, title, doc_type, file_url, related_member, created_at')
      .eq('family_id', fid)
      .order('created_at', { ascending: false });

    if (error) { console.error('读取文件失败:', error.message); return; }
    setDocs((data || []) as DocItem[]);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try { if (!cancelled) await loadDocs(); }
        finally { if (!cancelled) setLoading(false); }
      })();
      return () => { cancelled = true; };
    }, [loadDocs])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadDocs(); }
    finally { setRefreshing(false); }
  }, [loadDocs]);

  const uploadFile = async (
    uri: string,
    fileName: string,
    mimeType: string,
    docType: string
  ) => {
    if (!familyId || !userId) return;
    setUploading(true);

    try {
      // 读取文件为 blob
      const response = await fetch(uri);
      const blob = await response.blob();

      const ext = fileName.split('.').pop() || 'bin';
      const filePath = `${familyId}/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('family-documents')
        .upload(filePath, blob, { contentType: mimeType });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('family-documents')
        .getPublicUrl(filePath);

      const fileUrl = urlData.publicUrl;

      await supabase.from('documents').insert({
        family_id: familyId,
        uploaded_by: userId,
        title: fileName,
        doc_type: docType,
        file_url: fileUrl,
      } as any);

      await loadDocs();
      Alert.alert('上传成功', `「${fileName}」已保存`);
    } catch (e: any) {
      Alert.alert('上传失败', e.message || '请重试');
    } finally {
      setUploading(false);
    }
  };

  const handleCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('需要相机权限', '请在设置中允许访问相机');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const fileName = `拍照_${Date.now()}.jpg`;
      await uploadFile(asset.uri, fileName, 'image/jpeg', 'image');
    }
  };

  const handleAlbum = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('需要相册权限', '请在设置中允许访问相册');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsMultipleSelection: false,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const fileName = asset.fileName || `图片_${Date.now()}.jpg`;
      await uploadFile(asset.uri, fileName, 'image/jpeg', 'image');
    }
  };

  const handleDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', '*/*'],
      copyToCacheDirectory: true,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const mimeType = asset.mimeType || 'application/octet-stream';
      const docType = mimeType.includes('pdf') ? 'pdf' : 'other';
      await uploadFile(asset.uri, asset.name, mimeType, docType);
    }
  };

  const showUploadOptions = () => {
    Alert.alert('上传文件', '选择上传方式', [
      { text: '拍照', onPress: handleCamera },
      { text: '从相册选择', onPress: handleAlbum },
      { text: '选择文件', onPress: handleDocument },
      { text: '取消', style: 'cancel' },
    ]);
  };

  const renderItem = ({ item }: { item: DocItem }) => (
    <View style={styles.card}>
      <Text style={styles.cardIcon}>
        {docTypeLabel[item.doc_type]?.split(' ')[0] || '📎'}
      </Text>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
        <View style={styles.cardMeta}>
          <Text style={styles.cardMetaText}>
            {docTypeLabel[item.doc_type] || '文件'}
          </Text>
          {item.related_member && (
            <>
              <Text style={styles.dot}>·</Text>
              <Text style={styles.cardMetaText}>{item.related_member}</Text>
            </>
          )}
          <Text style={styles.dot}>·</Text>
          <Text style={styles.cardMetaText}>{formatDate(item.created_at)}</Text>
        </View>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>文件</Text>
          <Text style={styles.subtitle}>家庭资料库</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.uploadBtn, pressed && { opacity: 0.8 }]}
          onPress={showUploadOptions}
          disabled={uploading}>
          {uploading
            ? <ActivityIndicator size="small" color={colors.primaryForeground} />
            : <Text style={styles.uploadBtnText}>+ 上传</Text>
          }
        </Pressable>
      </View>

      {!loading && docs.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🗂️</Text>
          <Text style={styles.emptyTitle}>还没有文件</Text>
          <Text style={styles.emptyDesc}>上传体检报告、证件、合同等家庭资料</Text>
          <Pressable style={styles.emptyBtn} onPress={showUploadOptions}>
            <Text style={styles.emptyBtnText}>立即上传</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={docs}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListFooterComponent={<View style={{ height: 16 }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { fontSize: 22, fontWeight: '700', color: colors.foreground },
  subtitle: { marginTop: 6, fontSize: 14, color: colors.mutedForeground },
  uploadBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 72,
    alignItems: 'center',
  },
  uploadBtnText: { color: colors.primaryForeground, fontSize: 14, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.card,
    borderRadius: 14,
    shadowColor: 'rgba(31,31,31,0.08)',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 4,
    elevation: 1,
    gap: 12,
  },
  cardIcon: { fontSize: 28 },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 15, color: colors.foreground, marginBottom: 4 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  cardMetaText: { fontSize: 12, color: colors.mutedForeground },
  dot: { fontSize: 12, color: colors.mutedForeground },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyIcon: { fontSize: 48, marginBottom: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.foreground },
  emptyDesc: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center', lineHeight: 20 },
  emptyBtn: {
    marginTop: 8,
    backgroundColor: colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  emptyBtnText: { color: colors.primaryForeground, fontSize: 15, fontWeight: '600' },
});