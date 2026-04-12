import { LegalDocumentModal, type LegalDocKind } from '@/components/LegalDocumentModal';
import { Logo13Icon } from '@/components/Logo13Icon';
import { brand, colors } from '@/constants/designTokens';
import { loginErrorToChinese } from '@/lib/loginErrorZh';
import { normalizeChinaPhone, sendPhoneOtp, verifyPhoneOtpAndSignIn } from '@/lib/phoneAuth';
import { supabase } from '@/lib/supabase';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Check, ChevronLeft } from 'lucide-react-native';
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
/** 与产品文案一致：首屏发送成功后从 59 秒开始倒计时 */
const OTP_COOLDOWN_SECONDS = 59;

type Step = 'phone' | 'code';

export default function PhoneAuthScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [legalModal, setLegalModal] = useState<LegalDocKind | null>(null);
  const [phoneDigits, setPhoneDigits] = useState('');
  const [code, setCode] = useState('');
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
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('登录/注册失败');

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

  const onPhoneDigitsChange = (text: string) => {
    setPhoneDigits(text.replace(/\D/g, '').slice(0, 11));
  };

  const runSendOtp = async () => {
    if (!normalizeChinaPhone(phoneDigits)) {
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
      await sendPhoneOtp(phoneDigits);
      setCooldown(OTP_COOLDOWN_SECONDS);
      setStep('code');
      setCode('');
    } catch (e: unknown) {
      const zh = loginErrorToChinese(e);
      setError(zh === '操作失败，请稍后再试' ? '发送验证码失败，请稍后再试' : zh);
    } finally {
      setLoading(false);
    }
  };

  const onResend = async () => {
    if (cooldown > 0) return;
    await runSendOtp();
  };

  const onVerify = async () => {
    if (!normalizeChinaPhone(phoneDigits)) {
      setError('请输入有效的中国大陆手机号');
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
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
      await verifyPhoneOtpAndSignIn(supabase, phoneDigits, code.trim());
      await navigateAfterAuthenticated();
    } catch (e: unknown) {
      const zh = loginErrorToChinese(e);
      setError(zh === '操作失败，请稍后再试' ? '验证失败，请稍后再试' : zh);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={s.root}>
      <LinearGradient
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
            showsVerticalScrollIndicator={false}>
            <View style={s.header}>
              <View style={[s.logoMark, { width: LOGIN_LOGO_SIZE }]}>
                <Logo13Icon size={LOGIN_LOGO_SIZE} gradientIdSuffix="phone-auth" />
              </View>
              <View style={[s.logoTitleWrap, { width: LOGIN_LOGO_SIZE }]}>
                <Text style={s.logoTitle}>{brand.productName}</Text>
              </View>
              <View style={s.logoSubWrap}>
                <Text style={s.logoSub}>{brand.loginWelcomeSubtitle}</Text>
              </View>
            </View>

            <View style={s.card}>
              {step === 'code' ? (
                <Pressable
                  style={s.backRow}
                  onPress={() => {
                    setStep('phone');
                    setError('');
                  }}
                  hitSlop={12}>
                  <ChevronLeft size={22} color={colors.primary} strokeWidth={2} />
                  <Text style={s.backText}>返回修改手机号</Text>
                </Pressable>
              ) : null}

              {step === 'phone' ? (
                <>
                  <Text style={s.fieldLabel}>手机号</Text>
                  <View style={s.phoneRow}>
                    <View style={s.phonePrefix}>
                      <Text style={s.phonePrefixText}>+86</Text>
                    </View>
                    <TextInput
                      style={[s.input, s.phoneInput]}
                      value={phoneDigits}
                      onChangeText={onPhoneDigitsChange}
                      placeholder="请输入 11 位手机号"
                      placeholderTextColor={colors.mutedForeground}
                      keyboardType="phone-pad"
                      maxLength={11}
                    />
                  </View>
                </>
              ) : (
                <>
                  <Text style={s.fieldLabel}>验证码</Text>
                  <Text style={s.maskedPhoneHint}>
                    已发送至 +86 {phoneDigits.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')}
                  </Text>
                  <TextInput
                    style={s.input}
                    value={code}
                    onChangeText={t => setCode(t.replace(/\D/g, '').slice(0, 6))}
                    placeholder="请输入 6 位验证码"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                </>
              )}

              {error ? <Text style={s.error}>{error}</Text> : null}

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

              {step === 'phone' ? (
                <Pressable
                  disabled={loading || cooldown > 0}
                  onPress={runSendOtp}
                  style={({ pressed }) => [
                    s.secondaryBtn,
                    (loading || cooldown > 0) && { opacity: 0.55 },
                    pressed && { opacity: 0.88 },
                  ]}>
                  <Text style={s.secondaryBtnText}>
                    {cooldown > 0 ? `${cooldown}秒后重新发送` : '获取验证码'}
                  </Text>
                </Pressable>
              ) : (
                <>
                  <Pressable
                    disabled={loading}
                    onPress={onVerify}
                    style={({ pressed }) => [
                      s.submitPressable,
                      pressed && { opacity: 0.92 },
                      loading && { opacity: 0.65 },
                    ]}>
                    <LinearGradient
                      colors={[colors.primary, colors.accent]}
                      start={{ x: 0, y: 0.5 }}
                      end={{ x: 1, y: 0.5 }}
                      style={s.submitGradient}>
                      {loading ? (
                        <ActivityIndicator color={colors.primaryForeground} />
                      ) : (
                        <Text style={s.submitText}>验证并登录</Text>
                      )}
                    </LinearGradient>
                  </Pressable>
                  <Pressable
                    disabled={loading || cooldown > 0}
                    onPress={onResend}
                    style={s.resendWrap}>
                    <Text
                      style={[
                        s.resendText,
                        (loading || cooldown > 0) && s.resendTextDisabled,
                      ]}>
                      {cooldown > 0 ? `${cooldown}秒后重新发送` : '重新发送'}
                    </Text>
                  </Pressable>
                </>
              )}
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
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 32,
    justifyContent: 'center',
  },
  header: { alignItems: 'center', marginBottom: 36 },
  logoMark: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 0,
  },
  logoTitleWrap: {
    alignSelf: 'center',
    marginBottom: 8,
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
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 18,
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
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 16,
    alignSelf: 'flex-start',
  },
  backText: { fontSize: 14, color: colors.primary, fontWeight: '600' },
  fieldLabel: { fontSize: 13, color: colors.mutedForeground, marginBottom: 8 },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  phonePrefix: {
    height: 52,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    backgroundColor: colors.muted,
    justifyContent: 'center',
  },
  phonePrefixText: { fontSize: 15, fontWeight: '600', color: colors.foreground },
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
  phoneInput: { flex: 1, marginBottom: 0 },
  maskedPhoneHint: {
    fontSize: 13,
    color: colors.mutedForeground,
    marginBottom: 10,
  },
  error: { fontSize: 13, color: colors.destructive, marginTop: 12 },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginTop: 20,
  },
  agreementTextWrap: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
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
  agreementLink: { color: colors.primary, fontWeight: '600' },
  secondaryBtn: {
    marginTop: 24,
    height: 52,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: { fontSize: 15, color: colors.primary, fontWeight: '600' },
  submitPressable: {
    marginTop: 24,
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
  resendWrap: { marginTop: 18, alignItems: 'center' },
  resendText: { fontSize: 14, color: colors.primary, fontWeight: '600' },
  resendTextDisabled: { color: colors.mutedForeground, fontWeight: '500' },
});
