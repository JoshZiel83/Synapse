import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button, EmptyState, ScreenView } from '@/components/ui';

export default function NotFoundScreen() {
  const router = useRouter();

  return (
    <ScreenView>
      <View style={styles.wrap}>
        <EmptyState
          icon="compass"
          title="页面不存在"
          description="这个移动端路由还没有内容，或者链接已经失效。"
        />
        <Button label="回到首页" onPress={() => router.replace('/')} />
      </View>
    </ScreenView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingHorizontal: 18,
    justifyContent: 'center',
    gap: 18,
  },
});
