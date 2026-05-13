import { StyleSheet, View } from "react-native"

import { ROOT_TAB_ORDER, type RootTabKey } from "@/navigation/root-tabs"

export function RootTabPages({
  selectedTab,
  visitedTabs,
  renderTabPage,
}: {
  initialTab: RootTabKey
  selectedTab: RootTabKey
  visitedTabs: RootTabKey[]
  onSelectTab: (tab: RootTabKey) => void
  renderTabPage: (tab: RootTabKey) => React.ReactNode
}) {
  return (
    <View style={styles.webPager}>
      {ROOT_TAB_ORDER.map((tab) => {
        const isActive = selectedTab === tab

        return (
          <View
            key={tab}
            style={[
              styles.webPage,
              isActive ? styles.webPageActive : styles.webPageInactive,
            ]}
            pointerEvents={isActive ? "auto" : "none"}
          >
            {visitedTabs.includes(tab) ? renderTabPage(tab) : null}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  webPager: {
    flex: 1,
  },
  webPage: {
    flex: 1,
  },
  webPageActive: {
    display: "flex",
  },
  webPageInactive: {
    display: "none",
  },
})
