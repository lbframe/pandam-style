/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CSS <color> recognition for composite accounting (CSS Color 4 named and
// system colors, hex notation and color functions). A keyword that is not a
// color, such as `none`, is never accepted as one.

const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite ' +
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink ' +
    'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey ' +
    'lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive ' +
    'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise ' +
    'palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey ' +
    'snow springgreen steelblue tan teal thistle tomato turquoise violet wheat ' +
    'white whitesmoke yellow yellowgreen'
  ).split(' '),
);

const SYSTEM_COLORS = new Set(
  (
    'accentcolor accentcolortext activetext buttonborder buttonface ' +
    'buttontext canvas canvastext field fieldtext graytext highlight ' +
    'highlighttext linktext mark marktext selecteditem selecteditemtext ' +
    'visitedtext'
  ).split(' '),
);

const COLOR_FUNCTION =
  /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\((?:[^()]|\([^()]*\))*\)$/i;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isColor(value) {
  const v = value.trim();
  const lower = v.toLowerCase();
  return (
    HEX.test(v) ||
    COLOR_FUNCTION.test(v) ||
    NAMED_COLORS.has(lower) ||
    SYSTEM_COLORS.has(lower) ||
    lower === 'transparent' ||
    lower === 'currentcolor'
  );
}

export const CSS_COLOR_KEYWORDS = Object.freeze([
  ...NAMED_COLORS,
  ...SYSTEM_COLORS,
  'transparent',
  'currentcolor',
]);
