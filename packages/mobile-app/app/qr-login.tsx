import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, EmptyState, LoadingBlock, ScreenScroll, SectionHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/providers/session-provider';
import { theme } from '@/theme/tokens';
import type { AuthQrLoginResolveResponse, AuthSessionPersistence } from '@shared';

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return '无法读取二维码登录请求。';
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export default function QrLoginScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { user } = useSession();
  const [data, setData] = useState<AuthQrLoginResolveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'persistent' | 'temporary' | 'reject' | null>(null);

  useEffect(() => {
    if (!token) {
      setError('缺少二维码登录 token。');
      setLoading(false);
      return;
    }

    const safeToken = token;
    let cancelled = false;

    async function loadRequest() {
      setLoading(true);
      setError(null);

      try {
        const response = await api.resolveQrLogin(safeToken);
        if (!cancelled) {
          setData(response);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(getErrorMessage(nextError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadRequest();

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleApprove(sessionPersistence: AuthSessionPersistence) {
    if (!token) return;

    setAction(sessionPersistence);
    setError(null);

    try {
      const result = await api.approveQrLogin(token, sessionPersistence);
      setData((current) =>
        current
          ? {
              ...current,
              request: result.request,
            }
          : null,
      );
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setAction(null);
    }
  }

  async function handleReject() {
    if (!token) return;

    setAction('reject');
    setError(null);

    try {
      const result = await api.rejectQrLogin(token);
      setData((current) =>
        current
          ? {
              ...current,
              request: result.request,
            }
          : null,
      );
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setAction(null);
    }
  }

  const request = data?.request;
  const confirmation = data?.confirmation;

  return (
    <ScreenScroll bottomPadding={32}>
      <SectionHeader
        eyebrow="Verification"
        title="确认 Web 登录"
        subtitle="确认这次桌面端登录请求是否可信。你可以选择长期保持登录，或只授权临时会话。"
      />

      {loading ? (
        <Card>
          <LoadingBlock label="正在读取登录请求..." />
        </Card>
      ) : error || !request ? (
        <EmptyState
          icon="shield-off"
          title="无法确认这个登录"
          description={error || '二维码登录请求不存在或已经失效。'}
        />
      ) : (
        <Card style={styles.confirmCard}>
          <View style={styles.headline}>
            <View style={styles.headlineIcon}>
              <Feather
                name={
                  request.status === 'approved' || request.status === 'consumed'
                    ? 'check-circle'
                    : request.status === 'rejected'
                      ? 'x-circle'
                      : 'monitor'
                }
                size={22}
                color={theme.colors.primary}
              />
            </View>
            <View style={styles.headlineText}>
              <Text style={styles.title}>
                {request.status === 'pending_confirm'
                  ? '桌面端正在等待你的确认'
                  : request.status === 'approved' || request.status === 'consumed'
                    ? '这次 Web 登录已批准'
                    : '这次 Web 登录已拒绝'}
              </Text>
              <Text style={styles.subtitle}>
                {request.status === 'pending_confirm'
                  ? `浏览器设备：${confirmation?.browserLabel ?? request.browserLabel}`
                  : '如果这是你本人操作，现在可以回到电脑继续使用。'}
              </Text>
            </View>
          </View>

          <View style={styles.metaGrid}>
            <MetaRow label="浏览器" value={confirmation?.browserLabel ?? request.browserLabel} />
            <MetaRow label="请求时间" value={formatTimestamp(confirmation?.requestedAt ?? request.createdAt)} />
            <MetaRow label="当前账号" value={user?.name || user?.email || '当前账号'} />
            <MetaRow
              label="状态"
              value={
                request.status === 'pending_confirm'
                  ? '待确认'
                  : request.status === 'approved' || request.status === 'consumed'
                    ? '已批准'
                    : '已拒绝'
              }
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {request.status === 'pending_confirm' ? (
            <View style={styles.actions}>
              <Button
                label={action === 'persistent' ? '批准中...' : '保持登录'}
                icon="shield"
                onPress={() => void handleApprove('persistent')}
                disabled={action !== null}
              />
              <Button
                label={action === 'temporary' ? '批准中...' : '临时登录'}
                variant="secondary"
                onPress={() => void handleApprove('temporary')}
                disabled={action !== null}
              />
              <Button
                label={action === 'reject' ? '拒绝中...' : '拒绝此次登录'}
                variant="ghost"
                icon="x"
                onPress={() => void handleReject()}
                disabled={action !== null}
              />
            </View>
          ) : null}
        </Card>
      )}
    </ScreenScroll>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  confirmCard: {
    gap: 18,
  },
  headline: {
    flexDirection: 'row',
    gap: 14,
  },
  headlineIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headlineText: {
    flex: 1,
    gap: 6,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: theme.colors.text,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.textMuted,
  },
  metaGrid: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceMuted,
    overflow: 'hidden',
  },
  metaRow: {
    paddingHorizontal: 16,
    paddingVertical: 13,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  metaLabel: {
    fontSize: 13,
    color: theme.colors.textSoft,
  },
  metaValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 13,
    color: theme.colors.text,
    fontWeight: '600',
  },
  actions: {
    gap: 10,
  },
  error: {
    fontSize: 13,
    color: theme.colors.danger,
  },
});
