// The picture format, as src/format.ts writes it. Keep the two in step:
// src/format.test.ts reads this file and compares every value.
#pragma once

namespace WindowsCanvas::Format {

constexpr int kVersion = 2;

namespace Op {
constexpr int Fill = 1;
constexpr int Stroke = 2;
constexpr int Text = 3;
constexpr int Clear = 4;
constexpr int Clip = 5;
constexpr int PopClip = 6;
constexpr int Image = 7;
constexpr int PutImage = 8;
constexpr int SetComposite = 9;
constexpr int SetShadow = 10;
constexpr int SetFilter = 11;
constexpr int SetSmoothing = 12;
} // namespace Op

namespace Segment {
constexpr int Move = 0;
constexpr int Line = 1;
constexpr int Quad = 2;
constexpr int Cubic = 3;
constexpr int Close = 4;
} // namespace Segment

namespace Paint {
constexpr int Solid = 0;
constexpr int Linear = 1;
constexpr int Radial = 2;
constexpr int Conic = 3;
constexpr int Pattern = 4;
} // namespace Paint

namespace Repetition {
constexpr int Repeat = 0;
constexpr int RepeatX = 1;
constexpr int RepeatY = 2;
constexpr int NoRepeat = 3;
} // namespace Repetition

namespace FillRule {
constexpr int NonZero = 0;
constexpr int EvenOdd = 1;
} // namespace FillRule

namespace LineCap {
constexpr int Butt = 0;
constexpr int Round = 1;
constexpr int Square = 2;
} // namespace LineCap

namespace LineJoin {
constexpr int Miter = 0;
constexpr int Round = 1;
constexpr int Bevel = 2;
} // namespace LineJoin

namespace FontStyle {
constexpr int Normal = 0;
constexpr int Italic = 1;
constexpr int Oblique = 2;
} // namespace FontStyle

namespace Kerning {
constexpr int Auto = 0;
constexpr int Normal = 1;
constexpr int None = 2;
} // namespace Kerning

namespace VariantCaps {
constexpr int Normal = 0;
constexpr int SmallCaps = 1;
constexpr int AllSmallCaps = 2;
constexpr int PetiteCaps = 3;
constexpr int AllPetiteCaps = 4;
constexpr int Unicase = 5;
constexpr int TitlingCaps = 6;
} // namespace VariantCaps

namespace TextRendering {
constexpr int Auto = 0;
constexpr int OptimizeSpeed = 1;
constexpr int OptimizeLegibility = 2;
constexpr int GeometricPrecision = 3;
} // namespace TextRendering

namespace SmoothingQuality {
constexpr int Low = 0;
constexpr int Medium = 1;
constexpr int High = 2;
} // namespace SmoothingQuality

namespace Composite {
constexpr int SourceOver = 0;
constexpr int SourceIn = 1;
constexpr int SourceOut = 2;
constexpr int SourceAtop = 3;
constexpr int DestinationOver = 4;
constexpr int DestinationIn = 5;
constexpr int DestinationOut = 6;
constexpr int DestinationAtop = 7;
constexpr int Lighter = 8;
constexpr int Copy = 9;
constexpr int Xor = 10;
constexpr int Multiply = 11;
constexpr int Screen = 12;
constexpr int Overlay = 13;
constexpr int Darken = 14;
constexpr int Lighten = 15;
constexpr int ColorDodge = 16;
constexpr int ColorBurn = 17;
constexpr int HardLight = 18;
constexpr int SoftLight = 19;
constexpr int Difference = 20;
constexpr int Exclusion = 21;
constexpr int Hue = 22;
constexpr int Saturation = 23;
constexpr int Color = 24;
constexpr int Luminosity = 25;
} // namespace Composite

namespace Filter {
constexpr int Blur = 1;
constexpr int Brightness = 2;
constexpr int Contrast = 3;
constexpr int Grayscale = 4;
constexpr int HueRotate = 5;
constexpr int Invert = 6;
constexpr int Opacity = 7;
constexpr int Saturate = 8;
constexpr int Sepia = 9;
constexpr int DropShadow = 10;
} // namespace Filter

} // namespace WindowsCanvas::Format
