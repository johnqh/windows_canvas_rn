// The picture format, as src/format.ts writes it. Keep the two in step:
// src/format.test.ts reads this file and compares every value.
#pragma once

namespace WindowsCanvas::Format {

constexpr int kVersion = 1;

namespace Op {
constexpr int Fill = 1;
constexpr int Stroke = 2;
constexpr int Text = 3;
constexpr int ClearRect = 4;
constexpr int Clip = 5;
constexpr int PopClip = 6;
} // namespace Op

namespace Segment {
constexpr int Move = 0;
constexpr int Line = 1;
constexpr int Quad = 2;
constexpr int Cubic = 3;
constexpr int Close = 4;
} // namespace Segment

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

namespace TextAlign {
constexpr int Start = 0;
constexpr int Center = 1;
constexpr int End = 2;
} // namespace TextAlign

namespace TextBaseline {
constexpr int Alphabetic = 0;
constexpr int Top = 1;
constexpr int Middle = 2;
constexpr int Bottom = 3;
} // namespace TextBaseline

} // namespace WindowsCanvas::Format
