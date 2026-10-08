/**
 * The native view: `WindowsCanvasPicture` in windows/WindowsCanvasPicture.cpp.
 *
 * Kept as TypeScript source in the published package (`react-native` points at
 * `src`), because React Native's codegen Babel plugin reads these prop types to
 * build the view config — a compiled `.js` has none left to read.
 */
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';
import type { Double } from 'react-native/Libraries/Types/CodegenTypes';
import type { HostComponent, ViewProps } from 'react-native';

export interface NativeProps extends ViewProps {
  ops?: ReadonlyArray<Double>;
  strings?: ReadonlyArray<string>;
}

export default codegenNativeComponent<NativeProps>(
  'WindowsCanvasPicture'
) as HostComponent<NativeProps>;
