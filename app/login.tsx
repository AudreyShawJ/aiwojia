import { LegalDocumentModal, type LegalDocKind } from '@/components/LegalDocumentModal';
import { Logo13Icon } from '@/components/Logo13Icon';
import { brand, colors } from '@/constants/designTokens';
import { loginErrorToChinese } from '@/lib/loginErrorZh';
import {
  normalizeChinaPhone,
  sendPhoneOtp,
  verifyPhoneOtpAndSignIn,
} from '@/lib/phoneAuth';
import { supabase } from '@/lib/supabase';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const LOGIN_LOGO_SIZE = 112;

export default function LoginScreen() {
  const router = useRouter();
  const [legalModal, setLegalModal] = useState<LegalDocKind | null>(null);
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => {
      setCooldown(c => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const navigateAfterAuthenticated = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('登录失败');

    const { data: existingUser, error: userRowError } = await supabase
      .from('users')
      .select('family_id')
      .eq('id', user.id)
      .single();

    if (userRowError) {
      router.replace('/setup');
      return;
    }
    if (existingUser?.family_id) {
      router.replace('/(tabs)');
    } else {
      router.replace('/setup');
    }
  };

  const requestSmsCode = async () => {
    if (!normalizeChinaPhone(phone)) {
      setError('请输入有效的中国大陆手机号');
      return;
    }
    if (!agreedToTerms) {
      Alert.alert('提示', '请先阅读并同意《隐私政策》和《用户服务协议》');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await sendPhoneOtp(phone);
      setCooldown(60);
    } catch (e: any) {
      const zh = loginErrorToChinese(e);
      setError(zh === '操作失败，请稍后再试' ? '发送验证码失败，请稍后再试' : zh);
    } finally {
      setLoading(false);
    }
  };

  const signInWithPhoneOtp = async () => {
    if (!normalizeChinaPhone(phone)) {
      setError('请输入有效的中国大陆手机号');
      return;
    }
    if (!/^\d{6}$/.test(smsCode.trim())) {
      setError('请输入 6 位短信验证码');
      return;
    }
    if (!agreedToTerms) {
      Alert.alert('提示', '请先阅读并同意《隐私政策》和《用户服务协议》');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await verifyPhoneOtpAndSignIn(supabase, phone, smsCode.trim());
      await navigateAfterAuthenticated();
    } catch (e: any) {
      setError(loginErrorToChinese(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={s.root}>
      <LinearGradient
        pointerEvents="none"
        colors={[colors.background, colors.background, 'rgba(90, 108, 255, 0.06)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={s.safe}>
        <KeyboardAvoidingView
          style={s.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}>
          <ScrollView
            contentContainerStyle={s.scrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            {...(Platform.OS === 'ios'
              ? { contentInsetAdjustmentBehavior: 'never' as const }
              : {})}>

            {/* Logo 区域 */}
            <View style={s.header}>
              <View style={[s.logoMark, { width: LOGIN_LOGO_SIZE }]}>
                <Logo13Icon size={LOGIN_LOGO_SIZE} gradientIdSuffix="login" />
              </View>
              <View style={[s.logoTitleWrap, { width: LOGIN_LOGO_SIZE }]}>
                <Text style={s.logoTitle}>{brand.productName}</Text>
              </View>
              <View style={s.logoSubWrap}>
                <Text style={s.logoSub}>{brand.loginWelcomeSubtitle}</Text>
              </View>
            </View>

            {/* 登录卡片 */}
            <View style={s.card}>
              <Text style={s.cardTitle}>手机号登录</Text>

              <Text style={s.fieldLabel}>手机号</Text>
              <TextInput
                style={s.input}
                value={phone}
                onChangeText={setPhone}
                placeholder="请输入 11 位手机号"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="phone-pad"
                maxLength={13}
                {...(Platform.OS === 'ios' ? { textContentType: 'telephoneNumber' as const } : {})}
              />

              <Text style={[s.fieldLabel, { marginTop: 16 }]}>验证码</Text>
              <View style={s.otpRow}>
                <TextInput
                  style={[s.input, s.otpInput]}
                  value={smsCode}
                  onChangeText={setSmsCode}
                  placeholder="6 位验证码"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="number-pad"
                  maxLength={6}
                  {...(Platform.OS === 'ios' ? { textContentType: 'oneTimeCode' as const } : {})}
                />
                <Pressable
                  disabled={loading || cooldown > 0}
                  onPress={requestSmsCode}
                  style={({ pressed }) => [
                    s.smsCodeBtn,
                    (loading || cooldown > 0) && { opacity: 0.55 },
                    pressed && { opacity: 0.88 },
                  ]}>
                  <Text style={s.smsCodeBtnText}>
                    {cooldown > 0 ? `${cooldown}s` : '获取验证码'}
                  </Text>
                </Pressable>
              </View>

              {error ? <Text style={s.error}>{error}</Text> : null}

              {/* 协议勾选 */}
              <View style={s.checkboxRow}>
                <Pressable
                  onPress={() => setAgreedToTerms(v => !v)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: agreedToTerms }}
                  hitSlop={8}>
                  <View style={[s.checkbox, agreedToTerms && s.checkboxChecked]}>
                    {agreedToTerms ? (
                      <Check size={12} color={colors.primaryForeground} strokeWidth={3} />
                    ) : null}
                  </View>
                </Pressable>
                <View style={s.agreementTextWrap}>
                  <Text style={s.agreementLabel}>登录即表示您同意我们的</Text>
                  <Pressable onPress={() => setLegalModal('privacy')}>
                    <Text style={s.agreementLink}>《隐私政策》</Text>
                  </Pressable>
                  <Text style={s.agreementLabel}>和</Text>
                  <Pressable onPress={() => setLegalModal('terms')}>
                    <Text style={s.agreementLink}>《用户服务协议》</Text>
                  </Pressable>
                </View>
              </View>

              {/* 登录按钮 */}
              <Pressable
                disabled={loading}
                onPress={signInWithPhoneOtp}
                style={({ pressed }) => [s.submitPressable, pressed && { opacity: 0.92 }, loading && { opacity: 0.65 }]}>
                <LinearGradient
                  colors={[colors.primary, colors.accent]}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={s.submitGradient}>
                  {loading
                    ? <ActivityIndicator color={colors.primaryForeground} />
                    : <Text style={s.submitText}>登录</Text>
                  }
                </LinearGradient>
              </Pressable>
            </View>

          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      <LegalDocumentModal open={legalModal} onClose={() => setLegalModal(null)} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  safe: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingTop: 16,
    paddingBottom: 40,
    justifyContent: 'center',
  },
  header: { alignItems: 'center', marginBottom: 40 },
  logoMark: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  logoTitleWrap: {
    alignSelf: 'center',
    marginTop: 4,
    marginBottom: 10,
  },
  logoTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  logoSubWrap: {
    alignSelf: 'center',
    maxWidth: '100%',
    paddingHorizontal: 4,
  },
  logoSub: {
    fontSize: 13,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 20,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 24,
    padding: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: 'rgba(31,31,31,0.12)',
    shadowOpacity: 1,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: 24,
  },
  fieldLabel: {
    fontSize: 13,
    color: colors.mutedForeground,
    marginBottom: 8,
  },
  input: {
    height: 52,
    paddingHorizontal: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    borderRadius: 14,
    fontSize: 15,
    color: colors.foreground,
    backgroundColor: colors.muted,
  },
  otpRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  otpInput: { flex: 1 },
  smsCodeBtn: {
    height: 52,
    paddingHorizontal: 12,
    minWidth: 102,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smsCodeBtnText: { fontSize: 13, color: colors.primary, fontWeight: '600' },
  error: { fontSize: 13, color: colors.destructive, marginTop: 12 },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 24,
    marginBottom: 4,
  },
  agreementTextWrap: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 2 },
  checkbox: {
    marginTop: 2,
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  agreementLabel: {
    fontSize: 13,
    color: colors.mutedForeground,
    lineHeight: 20,
  },
  agreementLink: { fontSize: 13, color: colors.primary, fontWeight: '600', lineHeight: 20 },
  submitPressable: {
    marginTop: 28,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: colors.primary,
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  submitGradient: {
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: colors.primaryForeground, fontSize: 15, fontWeight: '600' },
});
