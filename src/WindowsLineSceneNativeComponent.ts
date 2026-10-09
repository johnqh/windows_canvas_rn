/**
 * The native view: `WindowsLineScene` in windows/LineScene.cpp.
 *
 * Kept as TypeScript source in the published package for the same reason as
 * `WindowsCanvasPictureNativeComponent.ts`: the codegen Babel plugin reads
 * these prop types to build the view config.
 */
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';
import type { Double } from 'react-native/Libraries/Types/CodegenTypes';
import type { HostComponent, ViewProps } from 'react-native';

export interface NativeProps extends ViewProps {
  vertices?: ReadonlyArray<Double>;
  vertexCounts?: ReadonlyArray<Double>;
  transforms?: ReadonlyArray<Double>;
  colors?: ReadonlyArray<Double>;
  camera?: ReadonlyArray<Double>;
  fog?: ReadonlyArray<Double>;
  background?: Double;
}

export default codegenNativeComponent<NativeProps>(
  'WindowsLineScene'
) as HostComponent<NativeProps>;
