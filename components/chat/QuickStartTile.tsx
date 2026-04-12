import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

const PRIMARY = '#5A6CFF';
const SECONDARY = '#7C8BFF';
const CARD = '#FFFFFF';

export type QuickStartTileProps = {
  title: string;
  description: string;
  onPress: () => void;
  columnWidth?: `${number}%` | number;
};

export function QuickStartTile({
  title,
  description,
  onPress,
  columnWidth = '48%',
}: QuickStartTileProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scale, {
      toValue: 0.98,
      friction: 6,
      tension: 400,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scale, {
      toValue: 1,
      friction: 5,
      tension: 400,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[{ width: columnWidth as `${number}%`, transform: [{ scale }] }]}>
      <Pressable
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}>
        <View style={styles.textBlock}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pressable: {
    backgroundColor: CARD,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(90, 108, 255, 0.18)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  pressed: {
    backgroundColor: 'rgba(124, 139, 255, 0.12)',
    borderColor: SECONDARY,
  },
  textBlock: { gap: 4 },
  title: {
    fontSize: 15,
    lineHeight: 20,
    color: PRIMARY,
    fontWeight: '700',
  },
  description: {
    fontSize: 13,
    lineHeight: 18,
    color: 'rgba(31, 31, 31, 0.55)',
    fontWeight: '400',
  },
});
