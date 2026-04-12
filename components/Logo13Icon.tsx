/**
 * Figma Logo13（方案十三）彩色版：Apple 风格「家厘」图形标
 * colorScheme=color：渐变屋顶 + 主色描边「里」结构
 */
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Stop } from 'react-native-svg';

type Props = {
  size?: number;
  /** 同一屏多个实例时传入不同 id，避免渐变 id 冲突 */
  gradientIdSuffix?: string;
  /** 白描边版：放在品牌渐变底、深色条等场景 */
  variant?: 'color' | 'white';
};

const WHITE = '#FFFFFF';

export function Logo13Icon({ size = 96, gradientIdSuffix = 'main', variant = 'color' }: Props) {
  const gid = `logo13-grad-${gradientIdSuffix}`;
  const accent = variant === 'white' ? WHITE : '#5A6CFF';
  const grad2 = variant === 'white' ? WHITE : '#7B8AFF';

  if (variant === 'white') {
    return (
      <Svg width={size} height={size} viewBox="0 0 100 100" fill="none">
        <Path
          d="M 25 48 Q 50 25, 75 48"
          stroke={WHITE}
          strokeWidth={7}
          strokeLinecap="round"
          fill="none"
        />
        <G>
          <Path
            d="M 35 50 Q 50 46, 65 50 L 65 70 Q 50 73, 35 70 Z"
            stroke={WHITE}
            strokeWidth={4.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <Path
            d="M 35 60 Q 50 58.5, 65 60"
            stroke={WHITE}
            strokeWidth={3.5}
            strokeLinecap="round"
            fill="none"
          />
          <Line
            x1={50}
            y1={46}
            x2={50}
            y2={73}
            stroke={WHITE}
            strokeWidth={3.5}
            strokeLinecap="round"
          />
        </G>
        <Path
          d="M 28 73 Q 50 76, 72 73"
          stroke={WHITE}
          strokeWidth={5}
          strokeLinecap="round"
          opacity={0.92}
        />
        <Circle cx={50} cy={30} r={2.5} fill={WHITE} opacity={0.55} />
      </Svg>
    );
  }

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <Defs>
        <LinearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#5A6CFF" />
          <Stop offset="100%" stopColor="#7B8AFF" />
        </LinearGradient>
      </Defs>
      <Path
        d="M 25 48 Q 50 25, 75 48"
        stroke={`url(#${gid})`}
        strokeWidth={7}
        strokeLinecap="round"
        fill="none"
      />
      <G>
        <Path
          d="M 35 50 Q 50 46, 65 50 L 65 70 Q 50 73, 35 70 Z"
          stroke={accent}
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <Path
          d="M 35 60 Q 50 58.5, 65 60"
          stroke={accent}
          strokeWidth={3.5}
          strokeLinecap="round"
          fill="none"
        />
        <Line
          x1={50}
          y1={46}
          x2={50}
          y2={73}
          stroke={accent}
          strokeWidth={3.5}
          strokeLinecap="round"
        />
      </G>
      <Path
        d="M 28 73 Q 50 76, 72 73"
        stroke={`url(#${gid})`}
        strokeWidth={5}
        strokeLinecap="round"
        opacity={0.8}
      />
      <Circle cx={50} cy={30} r={2.5} fill={grad2} opacity={0.5} />
    </Svg>
  );
}
