import PagerView, {
  type PagerViewOnPageSelectedEvent,
} from "react-native-pager-view";
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";

import {
  ROOT_TAB_ORDER,
  getRootTabByIndex,
  getRootTabIndex,
  type RootTabKey,
} from "@/navigation/root-tabs";

export function RootTabPages({
  initialTab,
  selectedTab,
  visitedTabs,
  onSelectTab,
  renderTabPage,
}: {
  initialTab: RootTabKey;
  selectedTab: RootTabKey;
  visitedTabs: RootTabKey[];
  onSelectTab: (tab: RootTabKey) => void;
  renderTabPage: (tab: RootTabKey) => React.ReactNode;
}) {
  const pagerRef = useRef<PagerView | null>(null);
  const selectedIndexRef = useRef(getRootTabIndex(initialTab));

  useEffect(() => {
    const nextIndex = getRootTabIndex(selectedTab);
    if (nextIndex === selectedIndexRef.current) {
      return;
    }

    selectedIndexRef.current = nextIndex;
    pagerRef.current?.setPage(nextIndex);
  }, [selectedTab]);

  function handlePageSelected(event: PagerViewOnPageSelectedEvent) {
    const nextIndex = event.nativeEvent.position;
    if (nextIndex === selectedIndexRef.current) {
      return;
    }

    selectedIndexRef.current = nextIndex;
    onSelectTab(getRootTabByIndex(nextIndex));
  }

  return (
    <PagerView
      ref={pagerRef}
      style={styles.pager}
      initialPage={getRootTabIndex(initialTab)}
      keyboardDismissMode="on-drag"
      offscreenPageLimit={ROOT_TAB_ORDER.length}
      overScrollMode="never"
      onPageSelected={handlePageSelected}
    >
      {ROOT_TAB_ORDER.map((tab) => (
        <View key={tab} style={styles.page}>
          {visitedTabs.includes(tab) ? renderTabPage(tab) : null}
        </View>
      ))}
    </PagerView>
  );
}

const styles = StyleSheet.create({
  pager: {
    flex: 1,
  },
  page: {
    flex: 1,
  },
});
