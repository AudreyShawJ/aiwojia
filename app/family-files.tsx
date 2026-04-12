import { colors } from '@/constants/designTokens';
import { supabase } from '@/lib/supabase';
import { decodeBase64ToUint8, readFileAsBase64 } from '@/lib/file-upload';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { HardDrive, Trash2, Upload } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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

type TabType = 'image' | 'video' | 'file';

const formatDate = (dateStr: string) => {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(dateStr))
    .reduce<Record<string, string>>((acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export default function FamilyFilesScreen() {
  const router = useRouter();
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('image');
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);
      const { data: userData } = await supabase
        .from('users').select('family_id').eq('id', user.id).single();
      const fid = userData?.family_id;
      if (!fid) { setLoading(false); return; }
      setFamilyId(fid);
      await loadDocs(fid);
      setLoading(false);
    })();
  }, []);

  const loadDocs = async (fid: string) => {
    const { data } = await supabase
      .from('documents')
      .select('id, title, doc_type, file_url, related_member, created_at')
      .eq('family_id', fid)
      .order('created_at', { ascending: false });
    setDocs((data || []) as DocItem[]);
  };

  const uploadFile = async (uri: string, fileName: string, mimeType: string, docType: string) => {
    if (!userId || !familyId) return;
    setUploading(true);
    try {
      const base64 = await readFileAsBase64(uri, fileName);
      const ext = fileName.split('.').pop()?.toLowerCase() || 'bin';
      const filePath = `${familyId}/${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('family-documents').upload(filePath, decodeBase64ToUint8(base64), { contentType: mimeType });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from('family-documents').getPublicUrl(filePath);
      await supabase.from('documents').insert({
        family_id: familyId, uploaded_by: userId,
        title: fileName, doc_type: docType, file_url: urlData.publicUrl,
      } as any);
      await loadDocs(familyId);
      Alert.alert('上传成功', `「${fileName}」已保存`);
    } catch (e: any) {
      Alert.alert('上传失败', e.message || '请重试');
    } finally {
      setUploading(false);
    }
  };

  const handleUpload = () => {
    Alert.alert('上传文件', '选择方式', [
      {
        text: '拍照', onPress: async () => {
          const { status } = await ImagePicker.requestCameraPermissionsAsync();
          if (status !== 'granted') { Alert.alert('需要相机权限'); return; }
          const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
          if (!result.canceled && result.assets[0]) {
            await uploadFile(result.assets[0].uri, `拍照_${Date.now()}.jpg`, 'image/jpeg', 'image');
          }
        }
      },
      {
        text: '从相册选择', onPress: async () => {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== 'granted') { Alert.alert('需要相册权限'); return; }
          const result = await ImagePicker.launchImageLibraryAsync({
            quality: 0.8, allowsMultipleSelection: true, selectionLimit: 3,
            mediaTypes: ImagePicker.MediaTypeOptions.All,
          });
          if (!result.canceled) {
            for (const asset of result.assets.slice(0, 3)) {
              const isVideo = asset.type === 'video';
              await uploadFile(asset.uri, asset.fileName || `文件_${Date.now()}`,
                isVideo ? 'video/mp4' : 'image/jpeg', isVideo ? 'video' : 'image');
            }
          }
        }
      },
      {
        text: '选择文件', onPress: async () => {
          const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
          if (!result.canceled) {
            for (const asset of result.assets.slice(0, 3)) {
              const mimeType = asset.mimeType || 'application/octet-stream';
              await uploadFile(asset.uri, asset.name, mimeType, mimeType.includes('pdf') ? 'pdf' : 'other');
            }
          }
        }
      },
      { text: '取消', style: 'cancel' },
    ]);
  };

  const handleDelete = (id: string, title: string) => {
    Alert.alert('确认删除文件？', title + '\n删除后无法恢复', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: async () => {
          await supabase.from('documents').delete().eq('id', id);
          setDocs(prev => prev.filter(d => d.id !== id));
        }
      },
    ]);
  };

  const filteredDocs = docs.filter(d => {
    const matchTab = activeTab === 'image' ? d.doc_type === 'image'
      : activeTab === 'video' ? d.doc_type === 'video'
      : d.doc_type === 'pdf' || d.doc_type === 'other';
    const matchSearch = !searchText || d.title.toLowerCase().includes(searchText.toLowerCase());
    return matchTab && matchSearch;
  });

  const tabCounts = {
    image: docs.filter(d => d.doc_type === 'image').length,
    video: docs.filter(d => d.doc_type === 'video').length,
    file: docs.filter(d => d.doc_type === 'pdf' || d.doc_type === 'other').length,
  };

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* header */}
      <View style={s.headerWrap}>
        <View style={s.headerTop}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/me')} style={s.backBtn}>
            <Text style={s.backText}>‹ 返回</Text>
          </Pressable>
          <Text style={s.headerTitle}>家庭资料</Text>
          <Pressable
            style={[s.uploadBtn, uploading && { opacity: 0.5 }]}
            onPress={handleUpload} disabled={uploading}>
            {uploading
              ? <ActivityIndicator size="small" color="#fff" />
              : <Upload size={16} color="#fff" strokeWidth={2} />
            }
          </Pressable>
        </View>

        {/* 存储空间 */}
        <View style={s.storageCard}>
          <View style={s.storageRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <HardDrive size={14} color={colors.primary} strokeWidth={1.5} />
              <Text style={s.storageLabel}>存储空间</Text>
            </View>
            <Text style={s.storageValue}>{docs.length} 个文件</Text>
          </View>
          <View style={s.storageBar}>
            <View style={[s.storageBarFill, { width: `${Math.min((docs.length / 100) * 100, 100)}%` }]} />
          </View>
        </View>

        {/* 搜索框 */}
        <View style={s.searchWrap}>
          <TextInput
            style={s.searchInput}
            placeholder="搜索文件…"
            placeholderTextColor="#8E8E93"
            value={searchText}
            onChangeText={setSearchText}
          />
        </View>
      </View>

      {/* tab */}
      <View style={s.tabBar}>
        {([
          { key: 'image' as TabType, label: '图片' },
          { key: 'video' as TabType, label: '视频' },
          { key: 'file' as TabType, label: '文件' },
        ]).map(tab => (
          <Pressable
            key={tab.key}
            style={[s.tab, activeTab === tab.key && s.tabActive]}
            onPress={() => setActiveTab(tab.key)}>
            <Text style={[s.tabText, activeTab === tab.key && s.tabTextActive]}>
              {tab.label}
            </Text>
            <View style={[s.tabBadge, activeTab === tab.key && s.tabBadgeActive]}>
              <Text style={[s.tabBadgeText, activeTab === tab.key && s.tabBadgeTextActive]}>
                {tabCounts[tab.key]}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
      ) : filteredDocs.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyIcon}>
            {activeTab === 'image' ? '🖼️' : activeTab === 'video' ? '🎬' : '📄'}
          </Text>
          <Text style={s.emptyTitle}>
            {searchText ? '未找到相关文件' : `还没有${activeTab === 'image' ? '图片' : activeTab === 'video' ? '视频' : '文件'}`}
          </Text>
          {!searchText && (
            <Pressable style={s.emptyUploadBtn} onPress={handleUpload}>
              <Text style={s.emptyUploadBtnText}>+ 立即上传</Text>
            </Pressable>
          )}
        </View>
      ) : activeTab === 'image' ? (
        <ScrollView contentContainerStyle={s.gridContent}>
          <View style={s.grid}>
            {filteredDocs.map(doc => (
              <Pressable
                key={doc.id}
                style={s.gridItem}
                onLongPress={() => handleDelete(doc.id, doc.title)}>
                <Image source={{ uri: doc.file_url }} style={s.gridImage} resizeMode="cover" />
                <Text style={s.gridLabel} numberOfLines={1}>{doc.title}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={filteredDocs}
          keyExtractor={item => item.id}
          contentContainerStyle={s.listContent}
          renderItem={({ item }) => (
            <View style={s.fileCard}>
              <View style={s.fileIconWrap}>
                <Text style={s.fileIcon}>
                  {item.doc_type === 'video' ? '🎬' : item.doc_type === 'pdf' ? '📄' : '📎'}
                </Text>
              </View>
              <View style={s.fileInfo}>
                <Text style={s.fileTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={s.fileMeta}>{formatDate(item.created_at)}</Text>
              </View>
              <Pressable style={s.deleteBtn} onPress={() => handleDelete(item.id, item.title)}>
                <Trash2 size={15} color="#FF3B30" strokeWidth={1.5} />
              </Pressable>
            </View>
          )}
          ListFooterComponent={<View style={{ height: 24 }} />}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F6F7F9' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerWrap: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(31,31,31,0.06)',
    paddingBottom: 12,
  },
  headerTop: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
  },
  backBtn: { width: 60 },
  backText: { fontSize: 17, color: colors.primary },
  headerTitle: { fontSize: 17, fontWeight: '500', color: '#1F1F1F' },
  uploadBtn: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  storageCard: {
    marginHorizontal: 20, marginBottom: 12,
    backgroundColor: colors.primary + '08', borderRadius: 16,
    padding: 14, borderWidth: 0.5, borderColor: colors.primary + '20',
  },
  storageRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  storageLabel: { fontSize: 13, color: '#1F1F1F', fontWeight: '500' },
  storageValue: { fontSize: 12, color: '#8E8E93' },
  storageBar: { height: 6, backgroundColor: 'rgba(31,31,31,0.08)', borderRadius: 3, overflow: 'hidden' },
  storageBarFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 3 },
  searchWrap: { paddingHorizontal: 20 },
  searchInput: {
    height: 44, borderRadius: 14, backgroundColor: '#F0F1F3',
    paddingHorizontal: 14, fontSize: 15, color: '#1F1F1F',
  },
  tabBar: {
    flexDirection: 'row', backgroundColor: '#fff',
    paddingHorizontal: 20, paddingVertical: 10, gap: 8,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(31,31,31,0.06)',
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 8, borderRadius: 12, backgroundColor: '#F0F1F3',
  },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, color: '#8E8E93', fontWeight: '500' },
  tabTextActive: { color: '#fff' },
  tabBadge: { backgroundColor: 'rgba(0,0,0,0.08)', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1 },
  tabBadgeActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
  tabBadgeText: { fontSize: 11, color: '#8E8E93', fontWeight: '500' },
  tabBadgeTextActive: { color: '#fff' },
  gridContent: { padding: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gridItem: { width: '31.5%' },
  gridImage: { width: '100%', aspectRatio: 1, borderRadius: 10 },
  gridLabel: { fontSize: 10, color: '#8E8E93', marginTop: 4, textAlign: 'center' },
  listContent: { padding: 16, gap: 10 },
  fileCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: 16, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)',
    shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 4, elevation: 1,
  },
  fileIconWrap: {
    width: 50, height: 50, borderRadius: 14,
    backgroundColor: colors.primary + '12', alignItems: 'center', justifyContent: 'center',
  },
  fileIcon: { fontSize: 24 },
  fileInfo: { flex: 1 },
  fileTitle: { fontSize: 15, fontWeight: '500', color: '#1F1F1F' },
  fileMeta: { fontSize: 12, color: '#8E8E93', marginTop: 2 },
  deleteBtn: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: '#FF3B3010', alignItems: 'center', justifyContent: 'center',
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 17, fontWeight: '500', color: '#1F1F1F' },
  emptyUploadBtn: {
    backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12,
    borderRadius: 20, shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 8, elevation: 3,
    marginTop: 8,
  },
  emptyUploadBtnText: { color: '#fff', fontSize: 15, fontWeight: '500' },
});