import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, Field, Pill, ScreenScroll, SectionHeader } from '@/components/ui';
import { API_BASE } from '@/lib/config';
import { useSession } from '@/providers/session-provider';
import { theme } from '@/theme/tokens';
import { APP_NAME } from '@shared';

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return '登录失败，请检查邮箱和密码。';
}

export default function LoginScreen() {
  const router = useRouter();
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    if (!email.trim() || !password) {
      setError('请输入邮箱和密码。');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await signIn(email.trim(), password);
      router.replace('/');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScreenScroll bottomPadding={36}>
      <View style={styles.hero}>
        <Pill label="Cross-platform App · Phase 1" tone="accent" />
        <SectionHeader
          title={`${APP_NAME} Mobile`}
          subtitle="登录后可直接进入首页、聊天、联系人和个人中心。扫码登录、媒体发送、工作区切换均已接到同一套后端接口。"
        />
      </View>

      <Card>
        <Field
          label="邮箱"
          placeholder="name@company.com"
          autoCapitalize="none"
          keyboardType="email-address"
          autoCorrect={false}
          value={email}
          onChangeText={setEmail}
        />
        <Field
          label="密码"
          placeholder="输入登录密码"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button
          label={submitting ? '登录中...' : '登录进入应用'}
          icon="arrow-right"
          onPress={() => void handleLogin()}
          disabled={submitting}
        />
      </Card>

      <Card style={styles.metaCard}>
        <Text style={styles.metaTitle}>开发连接</Text>
        <Text style={styles.metaBody}>
          当前 API 地址：{API_BASE}
        </Text>
        <Text style={styles.metaHint}>
          这个地址只会从构建时环境变量 `EXPO_PUBLIC_API_URL` 读取；请在 `.env.local` 或启动命令里提供它。
        </Text>
      </Card>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: 14,
    paddingTop: 10,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
  metaCard: {
    gap: 8,
  },
  metaTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.text,
  },
  metaBody: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  metaHint: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.textSoft,
  },
});
