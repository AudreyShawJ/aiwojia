import { colors, categoryColors } from '@/constants/designTokens';
import { invalidateChatFamilyContextCache } from '@/lib/chatFamilyContextCache';
import { supabase } from '@/lib/supabase';
import { useFocusEffect } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronRight, Link, Plus, Trash2, UserPlus } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

type Member = {
  id: string;
  name: string;
  role: string;
  linked_user_id: string | null;
  sibling_order: string | null;
  notes: string | null;
};

type PendingSibling = { name: string; role: string; notes: string; editMemberId?: string };

type AppUser = { id: string; name: string; role: string };

const ROLE_COLORS: Record<string, string> = {
  丈夫: colors.primary, 老公: colors.primary,
  妻子: '#FF6B9D', 老婆: '#FF6B9D',
  女儿: categoryColors.finance, 儿子: categoryColors.house,
  妈妈: categoryColors.health, 母亲: categoryColors.health,
  爸爸: colors.primary, 父亲: colors.primary,
  丈夫父亲: categoryColors.vehicle,
  丈夫母亲: '#F472B6',
  妻子父亲: categoryColors.vehicle,
  妻子母亲: '#F472B6',
  /** 未迁移的旧库 role，与上对应祖辈同色 */
  爷爷: categoryColors.vehicle,
  奶奶: '#F472B6',
  外公: categoryColors.vehicle,
  外婆: '#F472B6',
  保姆: categoryColors.child,
  司机: '#45B7D1',
};

const ALL_ROLES = [
  '丈夫',
  '妻子',
  '儿子',
  '女儿',
  '丈夫父亲',
  '丈夫母亲',
  '妻子父亲',
  '妻子母亲',
  '保姆',
  '司机',
];
const SIBLING_ROLES = ['儿子', '女儿'];
const getRoleColor = (role: string) => ROLE_COLORS[role] || colors.primary;

function popFamilyMembersOrFallbackMe(router: ReturnType<typeof useRouter>) {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/(tabs)/me');
  }
}

export default function FamilyMembersScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { autoOpenAdd, prefillName } = useLocalSearchParams<{ autoOpenAdd?: string; prefillName?: string }>();
  const [members, setMembers] = useState<Member[]>([]);
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [familyCreatedBy, setFamilyCreatedBy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [adding, setAdding] = useState(false);

  const [showSiblingModal, setShowSiblingModal] = useState(false);
  const [pendingSibling, setPendingSibling] = useState<PendingSibling | null>(null);

  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkingUser, setLinkingUser] = useState<AppUser | null>(null);
  const [showAddFromLink, setShowAddFromLink] = useState(false);

  useFocusEffect(
    useCallback(() => {
      return () => {
        invalidateChatFamilyContextCache();
      };
    }, [])
  );

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: userData } = await supabase
        .from('users').select('family_id').eq('id', user.id).single();
      const fid = userData?.family_id;
      if (!fid) { setLoading(false); return; }
      setFamilyId(fid);
      const { data: famRow } = await supabase
        .from('families')
        .select('created_by')
        .eq('id', fid)
        .maybeSingle();
      setFamilyCreatedBy((famRow?.created_by as string | null) ?? null);
      const { members: m, appUsers: u } = await loadData(fid);
      setLoading(false);
      if (autoOpenAdd === '1') {
        setNewName(prefillName || '');
        setShowAddModal(true);
      }
      const unlinked = u.filter(au => !m.some(mem => mem.linked_user_id === au.id));
      if (unlinked.length > 0) {
        setLinkingUser(unlinked[0]);
        setShowLinkModal(true);
      }
    })();
  }, []);

  const loadData = async (fid: string) => {
    const membersRes = await supabase.from('family_members')
      .select('id, name, role, linked_user_id, sibling_order, notes')
      .eq('family_id', fid).order('created_at');
    if (membersRes.error) {
      console.error('[FamilyMembers] family_members 查询失败:', membersRes.error.message, membersRes.error);
    }
    const usersRes = await supabase.from('users')
      .select('id, name, role').eq('family_id', fid);
    if (usersRes.error) {
      console.error('[FamilyMembers] users 查询失败:', usersRes.error.message, usersRes.error);
    }
    const m = (membersRes.data || []) as Member[];
    const u = (usersRes.data || []) as AppUser[];
    setMembers(m);
    setAppUsers(u);
    return { members: m, appUsers: u };
  };

  const handleAddPress = (fromLink = false) => {
    setShowEditModal(false);
    setEditingMember(null);
    setNewName(''); setNewRole(''); setNewNotes('');
    if (fromLink) { setShowLinkModal(false); setShowAddFromLink(true); }
    else { setShowAddModal(true); }
  };

  const confirmSiblingOrder = (order: 'elder' | 'younger') => {
    const p = pendingSibling;
    if (!p) return;
    if (p.editMemberId) {
      void doUpdate(p.editMemberId, p.name, p.role, order, p.notes);
    } else {
      void doAdd(p.name, p.role, order, false, p.notes);
    }
  };

  const handleConfirmAdd = async (fromLink = false) => {
    if (!newName.trim() || !newRole) return;
    const hasSameRole = members.some(m => m.role === newRole);
    if (hasSameRole && SIBLING_ROLES.includes(newRole)) {
      setPendingSibling({ name: newName.trim(), role: newRole, notes: newNotes });
      setShowAddModal(false); setShowAddFromLink(false); setShowSiblingModal(true);
      return;
    }
    await doAdd(newName.trim(), newRole, null, fromLink, newNotes);
  };

  const openEditMember = (m: Member) => {
    setEditingMember(m);
    setNewName(m.name);
    setNewRole(m.role);
    setNewNotes(m.notes || '');
    setShowEditModal(true);
  };

  const handleConfirmEdit = async () => {
    if (!editingMember || !newName.trim() || !newRole) return;
    const otherSameRole = members.some(m => m.role === newRole && m.id !== editingMember.id);
    if (otherSameRole && SIBLING_ROLES.includes(newRole)) {
      setPendingSibling({
        name: newName.trim(),
        role: newRole,
        notes: newNotes,
        editMemberId: editingMember.id,
      });
      setShowEditModal(false);
      setShowSiblingModal(true);
      return;
    }
    await doUpdate(editingMember.id, newName.trim(), newRole, editingMember.sibling_order, newNotes);
  };

  const doUpdate = async (
    id: string,
    name: string,
    role: string,
    siblingOrder: string | null,
    notes: string
  ) => {
    if (!familyId) return;
    setAdding(true);
    try {
      const { error } = await supabase
        .from('family_members')
        .update({
          name,
          role,
          sibling_order: siblingOrder,
          notes: notes.trim() || null,
        } as any)
        .eq('id', id);
      if (error) throw error;
      setShowEditModal(false);
      setEditingMember(null);
      setNewName('');
      setNewRole('');
      setNewNotes('');
      setShowSiblingModal(false);
      setPendingSibling(null);
      await loadData(familyId);
    } catch (e: any) {
      Alert.alert('保存失败', e.message);
    } finally {
      setAdding(false);
    }
  };

  const doAdd = async (name: string, role: string, siblingOrder: string | null, fromLink = false, notes = '') => {
    if (!familyId) return;
    setAdding(true);
    try {
      const { data, error } = await supabase.from('family_members').insert({
        family_id: familyId, name, role, sibling_order: siblingOrder, notes: notes.trim() || null,
      } as any).select('id').single();
      if (error) throw error;
      setShowAddModal(false); setShowAddFromLink(false); setShowSiblingModal(false);
      setPendingSibling(null); setNewName(''); setNewRole(''); setNewNotes('');
      await loadData(familyId);
      if (fromLink && linkingUser && data?.id) {
        await supabase.from('family_members').update({ linked_user_id: linkingUser.id } as any).eq('id', data.id);
        await loadData(familyId);
        setLinkingUser(null);
      }
    } catch (e: any) {
      Alert.alert('添加失败', e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleLinkToMember = async (memberId: string) => {
    if (!linkingUser || !familyId) return;
    await supabase.from('family_members').update({ linked_user_id: linkingUser.id } as any).eq('id', memberId);
    setShowLinkModal(false); setLinkingUser(null);
    await loadData(familyId);
  };

  const handleUnlink = async (memberId: string) => {
    if (!familyId) return;
    await supabase.from('family_members').update({ linked_user_id: null } as any).eq('id', memberId);
    await loadData(familyId);
  };

  const handleDelete = (id: string, name: string) => {
    Alert.alert('删除成员', `确认删除「${name}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        await supabase.from('family_members').delete().eq('id', id);
        if (familyId) await loadData(familyId);
      }},
    ]);
  };

  const getLinkedMember = (userId: string) => members.find(m => m.linked_user_id === userId);

  if (loading) {
    return (
      <SafeAreaView style={s.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <Pressable onPress={() => popFamilyMembersOrFallbackMe(router)} style={s.backBtn}>
          <Text style={s.backText}>‹ 返回</Text>
        </Pressable>
        <Text style={s.headerTitle}>家庭成员</Text>
        <Pressable style={s.addIconBtn} onPress={() => handleAddPress(false)}>
          <Plus size={18} color="#fff" strokeWidth={2.5} />
        </Pressable>
      </View>

      <FlatList
        data={members}
        keyExtractor={item => item.id}
        contentContainerStyle={s.listContent}
        ListHeaderComponent={members.length > 0 ? <Text style={s.sectionLabel}>成员列表 · {members.length}人</Text> : null}
        renderItem={({ item }) => {
          const color = getRoleColor(item.role);
          const linkedUser = appUsers.find(u => u.id === item.linked_user_id);
          return (
            <View style={s.memberCard}>
              <Pressable style={s.memberCardMain} onPress={() => openEditMember(item)}>
                <View style={[s.memberAvatar, { backgroundColor: color + '18' }]}>
                  <Text style={[s.memberAvatarText, { color }]}>{item.name[0]}</Text>
                </View>
                <View style={s.memberInfo}>
                  <Text style={s.memberName}>{item.name}</Text>
                  <View style={s.memberMetaRow}>
                    <View style={[s.roleTag, { backgroundColor: color + '12' }]}>
                      <Text style={[s.roleTagText, { color }]}>{item.role}</Text>
                    </View>
                    {linkedUser && (
                      <View style={s.linkedTag}>
                        <Link size={10} color="#4ECDC4" strokeWidth={2} />
                        <Text style={s.linkedTagText}>{linkedUser.name}</Text>
                      </View>
                    )}
                  </View>
                </View>
              </Pressable>
              <Pressable style={s.deleteBtn} onPress={() => handleDelete(item.id, item.name)}>
                <Trash2 size={13} color="#FF3B30" strokeWidth={1.5} />
              </Pressable>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={s.empty}>
            <View style={s.emptyIconWrap}>
              <UserPlus size={32} color={colors.primary} strokeWidth={1.5} />
            </View>
            <Text style={s.emptyTitle}>还没有家庭成员</Text>
            <Text style={s.emptyDesc}>添加家人，让记录更有温度</Text>
            <Pressable style={s.emptyAddBtn} onPress={() => handleAddPress(false)}>
              <Text style={s.emptyAddBtnText}>+ 添加第一个成员</Text>
            </Pressable>
          </View>
        }
        ListFooterComponent={
          appUsers.length > 0 ? (
            <View style={{ marginTop: 24 }}>
              <Text style={s.sectionLabel}>APP账号 · {appUsers.length}人</Text>
              <View style={s.appUserGroup}>
                {appUsers.map((u, i) => {
                  const linked = getLinkedMember(u.id);
                  return (
                    <View key={u.id}>
                      <View style={s.appUserRow}>
                        <View style={[s.memberAvatar, { backgroundColor: colors.primary + '15' }]}>
                          <Text style={[s.memberAvatarText, { color: colors.primary }]}>{u.name[0].toUpperCase()}</Text>
                        </View>
                        <View style={s.memberInfo}>
                          <Text style={s.memberName}>{u.name}</Text>
                          <View style={s.memberMetaRow}>
                            <Text style={s.appUserRole}>{u.role === 'admin' ? '管理员' : '成员'}</Text>
                            {linked && (
                              <View style={s.linkedTag}>
                                <Link size={10} color="#4ECDC4" strokeWidth={2} />
                                <Text style={s.linkedTagText}>{linked.name}（{linked.role}）</Text>
                              </View>
                            )}
                          </View>
                        </View>
                        <View style={s.appUserActions}>
                          <Pressable
                            style={[s.linkActionBtn, linked && { backgroundColor: '#4ECDC415' }]}
                            onPress={() => {
                              if (linked) {
                                Alert.alert('取消关联', `确认取消「${u.name}」与「${linked.name}」的关联？`, [
                                  { text: '取消', style: 'cancel' },
                                  { text: '确认', style: 'destructive', onPress: () => handleUnlink(linked.id) },
                                ]);
                              } else {
                                setLinkingUser(u);
                                setShowLinkModal(true);
                              }
                            }}>
                            <Link size={13} color={linked ? '#4ECDC4' : '#8E8E93'} strokeWidth={2} />
                            <Text style={[s.linkActionText, linked && { color: '#4ECDC4' }]}>
                              {linked ? '已关联' : '关联'}
                            </Text>
                          </Pressable>
                          {familyCreatedBy && u.id === familyCreatedBy ? (
                            <View style={s.permBtnPlaceholder}>
                              <Text style={s.permBtnTextMuted}>创建者</Text>
                            </View>
                          ) : (
                            <Pressable
                              style={s.permBtn}
                              onPress={() =>
                                router.push({ pathname: '/permissions', params: { memberId: u.id, memberName: u.name } })
                              }>
                              <Text style={s.permBtnText}>权限</Text>
                              <ChevronRight size={13} color={colors.primary} strokeWidth={2} />
                            </Pressable>
                          )}
                        </View>
                      </View>
                      {i < appUsers.length - 1 && <View style={s.divider} />}
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null
        }
      />

      {/* 添加成员弹窗（普通） */}
      <Modal visible={showAddModal} transparent animationType="slide">
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={{ flex: 1 }}>
            <Pressable style={s.modalOverlay} onPress={() => { Keyboard.dismiss(); setShowAddModal(false); }} />
            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={insets.bottom} style={s.modalContainer}>
              <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                <View style={s.modalSheet}>
                  <View style={s.modalHandle} />
                  <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16 }}>
                    <Text style={s.modalTitle}>添加家庭成员</Text>
                    <Text style={s.modalDesc}>添加后AI可以识别和关联这位成员</Text>
                    <Text style={s.inputLabel}>姓名或称呼</Text>
                    <TextInput
                      style={s.input}
                      placeholder="如：老刘、泡泡、妈妈"
                      placeholderTextColor="#8E8E93"
                      value={newName}
                      onChangeText={setNewName}
                    />
                    <Text style={s.inputLabel}>角色</Text>
                    <View style={s.quickRoles}>
                      {ALL_ROLES.map(r => (
                        <Pressable
                          key={r}
                          style={[s.quickRoleBtn, newRole === r && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                          onPress={() => setNewRole(r)}>
                          <Text style={[s.quickRoleBtnText, newRole === r && { color: '#fff' }]}>{r}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Text style={s.inputLabel}>成员介绍（选填）</Text>
                    <TextInput
                      style={[s.input, { height: 90, textAlignVertical: 'top' }]}
                      placeholder={'越详细越好～比如年龄、喜好、血型、过敏史等\n让AI更懂TA，帮你把每件事都安排得妥妥的 🌿'}
                      placeholderTextColor="#8E8E93"
                      value={newNotes}
                      onChangeText={setNewNotes}
                      multiline
                    />
                    <Pressable
                      style={[s.confirmBtn, (!newName.trim() || !newRole || adding) && { opacity: 0.4 }]}
                      onPress={() => handleConfirmAdd(false)}
                      disabled={!newName.trim() || !newRole || adding}>
                      {adding ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.confirmBtnText}>确认添加</Text>}
                    </Pressable>
                  </ScrollView>
                </View>
              </TouchableWithoutFeedback>
            </KeyboardAvoidingView>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* 修改成员弹窗 */}
      <Modal visible={showEditModal} transparent animationType="slide">
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={{ flex: 1 }}>
            <Pressable
              style={s.modalOverlay}
              onPress={() => {
                Keyboard.dismiss();
                setShowEditModal(false);
                setEditingMember(null);
                setNewName('');
                setNewRole('');
                setNewNotes('');
              }}
            />
            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={insets.bottom} style={s.modalContainer}>
              <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                <View style={s.modalSheet}>
                  <View style={s.modalHandle} />
                  <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16 }}>
                    <Text style={s.modalTitle}>修改成员</Text>
                    <Text style={s.modalDesc}>修改后 AI 会按新信息识别这位成员</Text>
                    <Text style={s.inputLabel}>姓名或称呼</Text>
                    <TextInput
                      style={s.input}
                      placeholder="如：老刘、泡泡、妈妈"
                      placeholderTextColor="#8E8E93"
                      value={newName}
                      onChangeText={setNewName}
                    />
                    <Text style={s.inputLabel}>角色</Text>
                    <View style={s.quickRoles}>
                      {ALL_ROLES.map(r => (
                        <Pressable
                          key={r}
                          style={[s.quickRoleBtn, newRole === r && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                          onPress={() => setNewRole(r)}>
                          <Text style={[s.quickRoleBtnText, newRole === r && { color: '#fff' }]}>{r}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Text style={s.inputLabel}>成员介绍（选填）</Text>
                    <TextInput
                      style={[s.input, { height: 90, textAlignVertical: 'top' }]}
                      placeholder={'越详细越好～比如年龄、喜好、血型、过敏史等\n让AI更懂TA，帮你把每件事都安排得妥妥的 🌿'}
                      placeholderTextColor="#8E8E93"
                      value={newNotes}
                      onChangeText={setNewNotes}
                      multiline
                    />
                    <Pressable
                      style={[s.confirmBtn, (!newName.trim() || !newRole || adding) && { opacity: 0.4 }]}
                      onPress={() => handleConfirmEdit()}
                      disabled={!newName.trim() || !newRole || adding}>
                      {adding ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.confirmBtnText}>保存</Text>}
                    </Pressable>
                  </ScrollView>
                </View>
              </TouchableWithoutFeedback>
            </KeyboardAvoidingView>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* 添加成员弹窗（从关联流程） */}
      <Modal visible={showAddFromLink} transparent animationType="slide">
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={{ flex: 1 }}>
            <Pressable style={s.modalOverlay} onPress={() => { Keyboard.dismiss(); setShowAddFromLink(false); }} />
            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={insets.bottom} style={s.modalContainer}>
              <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                <View style={s.modalSheet}>
                  <View style={s.modalHandle} />
                  <Text style={s.modalTitle}>添加并关联成员</Text>
                  <Text style={s.modalDesc}>为「{linkingUser?.name}」创建对应的家庭成员</Text>
                  <Text style={s.inputLabel}>姓名或称呼</Text>
                  <TextInput
                    style={s.input}
                    placeholder="如：老刘、泡泡、妈妈"
                    placeholderTextColor="#8E8E93"
                    value={newName}
                    onChangeText={setNewName}
                  />
                  <Text style={s.inputLabel}>角色</Text>
                  <View style={s.quickRoles}>
                    {ALL_ROLES.map(r => (
                      <Pressable
                        key={r}
                        style={[s.quickRoleBtn, newRole === r && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                        onPress={() => setNewRole(r)}>
                        <Text style={[s.quickRoleBtnText, newRole === r && { color: '#fff' }]}>{r}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Pressable
                    style={[s.confirmBtn, (!newName.trim() || !newRole || adding) && { opacity: 0.4 }]}
                    onPress={() => handleConfirmAdd(true)}
                    disabled={!newName.trim() || !newRole || adding}>
                    {adding ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.confirmBtnText}>添加并关联</Text>}
                  </Pressable>
                </View>
              </TouchableWithoutFeedback>
            </KeyboardAvoidingView>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* 兄弟姐妹排行弹窗 */}
      <Modal visible={showSiblingModal} transparent animationType="slide">
        <Pressable
          style={s.modalOverlay}
          onPress={() => {
            setShowSiblingModal(false);
            setPendingSibling(null);
          }}
        />
        <View style={s.modalContainer}>
          <View style={s.modalSheet}>
            <View style={s.modalHandle} />
            <Text style={s.modalTitle}>确认排行</Text>
            <Text style={s.modalDesc}>
              家里已有「{pendingSibling?.role || ''}」，请确认「{pendingSibling?.name}」的排行
            </Text>
            <View style={s.siblingBtns}>
              <Pressable style={s.siblingBtn} onPress={() => confirmSiblingOrder('elder')}>
                <Text style={s.siblingBtnText}>{pendingSibling?.role === '儿子' ? '哥哥（较年长）' : '姐姐（较年长）'}</Text>
              </Pressable>
              <Pressable style={[s.siblingBtn, { backgroundColor: colors.primary }]} onPress={() => confirmSiblingOrder('younger')}>
                <Text style={[s.siblingBtnText, { color: '#fff' }]}>{pendingSibling?.role === '儿子' ? '弟弟（较年幼）' : '妹妹（较年幼）'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 关联账号弹窗 */}
      <Modal visible={showLinkModal} transparent animationType="slide">
        <Pressable style={s.modalOverlay} onPress={() => setShowLinkModal(false)} />
        <View style={s.modalContainer}>
          <View style={s.modalSheet}>
            <View style={s.modalHandle} />
            <Text style={s.modalTitle}>关联家庭成员</Text>
            <Text style={s.modalDesc}>「{linkingUser?.name}」对应家里哪位成员？</Text>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {members.map(m => {
                const color = getRoleColor(m.role);
                return (
                  <Pressable key={m.id} style={s.linkMemberRow} onPress={() => handleLinkToMember(m.id)}>
                    <View style={[s.memberAvatar, { backgroundColor: color + '18' }]}>
                      <Text style={[s.memberAvatarText, { color }]}>{m.name[0]}</Text>
                    </View>
                    <View style={s.memberInfo}>
                      <Text style={s.memberName}>{m.name}</Text>
                      <Text style={[s.appUserRole, { color }]}>{m.role}</Text>
                    </View>
                    <ChevronRight size={16} color="rgba(31,31,31,0.2)" strokeWidth={1.5} />
                  </Pressable>
                );
              })}
              <Pressable style={s.addNewMemberBtn} onPress={() => handleAddPress(true)}>
                <Plus size={16} color={colors.primary} strokeWidth={2} />
                <Text style={s.addNewMemberText}>没有对应成员，添加新成员</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F6F7F9' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(31,31,31,0.06)',
  },
  backBtn: { width: 60 },
  backText: { fontSize: 17, color: colors.primary },
  headerTitle: { fontSize: 17, fontWeight: '500', color: '#1F1F1F' },
  addIconBtn: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  listContent: { padding: 24, paddingBottom: 40 },
  sectionLabel: { fontSize: 13, color: '#8E8E93', marginBottom: 12 },
  memberCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 16, padding: 14, marginBottom: 8, gap: 12,
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.05)',
  },
  memberCardMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  memberAvatar: {
    width: 44, height: 44, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  memberAvatarText: { fontSize: 18, fontWeight: '600' },
  memberInfo: { flex: 1, gap: 4 },
  memberName: { fontSize: 15, fontWeight: '500', color: '#1F1F1F' },
  memberMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  roleTag: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  roleTagText: { fontSize: 12, fontWeight: '500' },
  linkedTag: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#4ECDC415', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  linkedTagText: { fontSize: 11, color: '#4ECDC4', fontWeight: '500' },
  deleteBtn: {
    width: 30, height: 30, borderRadius: 8,
    backgroundColor: '#FF3B3010', alignItems: 'center', justifyContent: 'center',
  },
  appUserGroup: {
    backgroundColor: '#fff', borderRadius: 20, overflow: 'hidden',
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)',
  },
  appUserRow: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  appUserRole: { fontSize: 12, color: '#8E8E93' },
  appUserActions: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  linkActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#F6F7F9', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 10,
  },
  linkActionText: { fontSize: 12, color: '#8E8E93', fontWeight: '500' },
  divider: { height: 0.5, backgroundColor: 'rgba(31,31,31,0.06)', marginLeft: 70 },
  permBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: colors.primary + '12', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10,
  },
  permBtnText: { fontSize: 12, color: colors.primary, fontWeight: '500' },
  permBtnPlaceholder: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#F6F7F9',
    justifyContent: 'center',
  },
  permBtnTextMuted: { fontSize: 12, color: '#8E8E93', fontWeight: '500' },
  empty: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: 22,
    backgroundColor: colors.primary + '12', alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  emptyTitle: { fontSize: 17, fontWeight: '500', color: '#1F1F1F' },
  emptyDesc: { fontSize: 14, color: '#8E8E93' },
  emptyAddBtn: {
    marginTop: 8, backgroundColor: colors.primary, paddingHorizontal: 24,
    paddingVertical: 12, borderRadius: 20,
    shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 8, elevation: 3,
  },
  emptyAddBtnText: { color: '#fff', fontSize: 15, fontWeight: '500' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  modalContainer: { justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: 24, paddingBottom: 40,
    maxHeight: '90%',
  },
  modalHandle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(31,31,31,0.12)',
    alignSelf: 'center', marginBottom: 20,
  },
  modalTitle: { fontSize: 20, fontWeight: '600', color: '#1F1F1F', marginBottom: 6 },
  modalDesc: { fontSize: 14, color: '#8E8E93', marginBottom: 20 },
  inputLabel: { fontSize: 13, color: '#8E8E93', marginBottom: 6 },
  input: {
    backgroundColor: '#F6F7F9', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: '#1F1F1F', marginBottom: 14,
  },
  quickRoles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  quickRoleBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.15)', backgroundColor: '#fff',
  },
  quickRoleBtnText: { fontSize: 13, color: '#1F1F1F' },
  confirmBtn: {
    backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center',
    shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 8, elevation: 3,
  },
  confirmBtnText: { color: '#fff', fontSize: 16, fontWeight: '500' },
  siblingBtns: { flexDirection: 'row', gap: 10 },
  siblingBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 14, alignItems: 'center',
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.15)',
  },
  siblingBtnText: { fontSize: 15, fontWeight: '500', color: '#1F1F1F' },
  linkMemberRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: 'rgba(31,31,31,0.06)',
  },
  addNewMemberBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginTop: 16, paddingVertical: 12, borderRadius: 14,
    borderWidth: 0.5, borderColor: colors.primary + '40',
  },
  addNewMemberText: { fontSize: 14, color: colors.primary, fontWeight: '500' },
});