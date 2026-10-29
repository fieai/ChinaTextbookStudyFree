'use strict';

// The prototype is the authoring source. No UI state (guesses, selected builds,
// checked items) is synthesized here, and answer-bearing fields stay in grading.
function createMathConverter(data, source) {
  const exact = text => {
    if (!source.includes(text)) throw new Error(`Missing math prototype literal: ${text}`);
    return text;
  };
  const directions = ['front', 'right', 'top'];
  const builds = list => list.map((build, index) => ({
    id: `build-${index + 1}`, name: build.name,
    visual: { kind: 'voxels', cubes: build.cubes },
  }));
  const cube = (list, activity, fields) => ({
    widget: 'cube-views', props: { builds: builds(list), directions, activity, ...fields },
  });
  const shapeNames = { tri: 'isosceles', heart: 'heart', rect: 'rectangle', para: 'parallelogram' };
  const axisShapes = { square: 'square', rect: 'rectangle', tri: 'equilateral', circle: 'circle' };
  const hints = {
    zero: exact('从 0 开始，终点的读数就是长度。'),
    nonzero: exact('起点不是 0，要用终点减起点。'),
  };
  const cmmm = mm => mm < 10 ? `${mm} 毫米` : `${Math.floor(mm / 10)} 厘米${mm % 10 ? ` ${mm % 10} 毫米` : ''}`;

  return function convertMath(prototypeId, index, extension) {
    if (prototypeId === data.VIEWS.id) {
      if (!extension && index === 0) return cube(data.VIEWS.builds, 'observe', {
        instructions: exact('站到哪一面，就看到哪一面'),
        explanation: exact('颜色对上号：蓝色是前面，黄色是右面，绿色是上面。从哪面看，就只看那种颜色的正方形。'),
        initialCaption: exact('搭好的样子'),
      });
      if (!extension && index === 1) return cube(data.VIEWS.builds, 'build', {
        buildSourceStageKey: 'basic-1',
        instructions: exact('用橡皮或积木，照样搭出来'),
        explanation: exact('蹲下来从前面看、走到右边看、站起来从上面看，在纸上方格里画出三幅图。'),
      });
      if (extension && index === 0) return cube(data.VIEWS.sameFront, 'compare', {
        directions: ['front', 'top'],
        instructions: exact('从前面看都一样，搭法却不同'),
        explanation: exact('只知道“从前面看是一排 3 个”，可能是 3 块、4 块、5 块……要再从上面看，才能分清。'),
      });
      if (extension && index === 1) {
        // These two grids are explicit clues in viewsRender, not derived answers.
        exact("gridSVG([[false, true, false], [true, true, true]], faceColor.front");
        exact("gridSVG([[false, true, false], [true, true, true]], faceColor.top");
        return cube(data.VIEWS.deduce, 'deduce', {
          instructions: exact('先在纸上想一想、画一画，再点下面的搭法核对。'),
          knownProjections: ['front', 'top'].map(direction => ({
            direction, visual: { kind: 'projection', grid: [[false, true, false], [true, true, true]] },
          })),
          explanation: [
            exact('从上面看有 4 格，所以底层是 4 块。'),
            exact('从前面看，中间那一列有 2 层：上面那块可以放在前面，也可以放在后面，还可以两个都放。'),
            exact('最少 5 块，最多 6 块。'), exact('要确定是哪种，还得从右面看一看。'),
          ].join('\n'),
        });
      }
    }
    if (prototypeId === data.MM.id) {
      if (!extension && index === 0) return { widget: 'mm-cells', props: {
        centimeters: 1, cellsPerCentimeter: 10,
        instructions: exact('1 厘米里有 10 个小格'),
        captions: {
          cells: exact('10 个小格，每一小格是 1 毫米。1 厘米 = 10 毫米。点“数刻度线”看看有几条线。'),
          lines: exact('刻度线有 11 条，比小格多 1 条。量长度数的是“格”，不是“线”。'),
        },
      } };
      if (!extension && index === 1) {
        exact('s.start = Number(value); s.end = s.start + 23');
        return { widget: 'ruler', props: {
          start: 0, end: 23, unit: 'mm', viewport: { fromMm: 0, toMm: 80 },
          editable: true, brokenEdge: false,
          instructions: exact('移动两端，先自己读，再核对'),
          checkLabel: exact('我读好了，核对'), readingHints: hints,
          presets: [
            { id: 'start-zero', label: exact('从 0 开始'), start: 0, end: 23 },
            { id: 'start-thirty', label: exact('从 3 厘米开始'), start: 30, end: 53 },
          ],
          // Ordered text demonstrates the source's initial 0–23 mm reading.
          // The contract has no dynamic readout-template protocol.
          readoutSteps: [`终点 ${cmmm(23)} − 起点 ${cmmm(0)}`, `= ${cmmm(23)} = 23 毫米`, hints.zero],
        } };
      }
      if (extension && index === 0) return {
        widget: 'unit-choice',
        props: {
          instructions: exact('填厘米还是毫米？'),
          sourceNote: exact('数据为常见近似值，可以找实物量一量。'),
          items: data.MM.units.map(([prompt], i) => ({ id: `unit-${i + 1}`, prompt, options: ['厘米', '毫米'] })),
        },
        grading: { items: data.MM.units.map(([prompt, answer, explanation], i) => ({
          id: `unit-${i + 1}`, answer, explanation,
          // mmRender uses q+a for a correct pick, why for the other pick.
          optionExplanations: Object.fromEntries(['厘米', '毫米'].map(option => [option,
            option === answer ? `${prompt} ${answer}。` : explanation])),
        })) },
      };
      if (extension && index === 1) return { widget: 'ruler', props: {
        start: 40, end: 75, unit: 'mm', viewport: { fromMm: 40, toMm: 100 },
        brokenEdge: true, editable: false,
        instructions: exact('尺子从 4 厘米开始，还能量吗？'),
        checkLabel: exact('说出长度后，点这里核对'), readingHints: hints,
        readoutSteps: [exact('7 厘米 5 毫米 − 4 厘米'), exact('= 3 厘米 5 毫米 = 35 毫米'),
          exact('也可以数：4 到 7 是 3 个大格，再加 5 个小格。')],
      } };
      if (extension && index === 2) return {
        widget: 'unit-compare',
        props: {
          instructions: exact('先统一单位，再比大小'),
          items: data.MM.compare.map(([left, right], i) => ({ id: `compare-${i + 1}`, left, right })),
        },
        grading: { items: data.MM.compare.map(([, , answer, explanation], i) => ({
          id: `compare-${i + 1}`, answer, explanation,
          // The original gives the same why after every relationship choice.
          optionExplanations: Object.fromEntries(['>', '<', '='].map(option => [option, explanation])),
        })) },
      };
    }
    if (prototypeId === data.SYM.id) {
      if (!extension && index === 0) return {
        widget: 'symmetry-fold',
        props: {
          activity: 'fold', instructions: exact('沿中线对折，两边能完全重合吗？'),
          initialCaption: exact('先猜一猜，再点“对折验证”。四个图形都试一试。'),
          shapes: Object.entries(data.SYM.shapes).map(([id, shape]) => ({
            id, name: shape.name, visual: { kind: 'shape', shape: shapeNames[id] }, foldAxis: 'vertical',
          })),
        },
        grading: { shapes: Object.fromEntries(Object.entries(data.SYM.shapes).map(([id, shape]) => [id, {
          symmetric: shape.yes,
          feedback: {
            match: shape.yes ? `完全重合！${shape.name}是轴对称图形，折痕就是对称轴。` : exact('完全重合！'),
            mismatch: exact(shape.yes ? '对不上，有的地方露出来了。' : '对不上，有的地方露出来了。平行四边形沿这条线折不能重合。'),
            correctGuess: exact('你猜对了。'), incorrectGuess: exact('和你猜的不一样，再看一看。'),
          },
        }])) },
      };
      if (!extension && index === 1) return {
        widget: 'symmetry-fold',
        props: {
          activity: 'axes', instructions: exact('先在纸上画，再一条一条核对'),
          initialCaption: exact('先自己在纸上画，再点“再找一条”核对。'),
          shapes: Object.entries(data.SYM.axes).map(([id, shape]) => ({
            id, name: shape.name, visual: { kind: 'shape', shape: axisShapes[id] }, foldAxis: 'vertical',
          })),
        },
        grading: { shapes: Object.fromEntries(Object.entries(data.SYM.axes).map(([id, shape]) => [id, {
          symmetric: true, axes: { count: id === 'circle' ? 'infinite' : shape.lines.length, lines: shape.lines },
        }])) },
      };
      if (extension && index === 0) return { widget: 'symmetry-fold', props: {
        activity: 'complete-grid', shapes: [],
        instructions: exact('点右边的格子，把图形补成轴对称'),
        initialCaption: exact('提示：离中线一样远的格子，两边要一样。'),
        grid: { kind: 'grid', cells: data.SYM.grid.target, columns: data.SYM.grid.cols, rows: data.SYM.grid.rows, half: true },
      } };
      if (extension && index === 1) return {
        widget: 'symmetry-fold',
        props: {
          activity: 'characters', shapes: [],
          instructions: exact('点一个字，想想沿竖线对折会怎样。'),
          sourceNote: exact('动手：在纸上画一个等腰三角形，剪下来，折一折。'),
          characters: data.SYM.chars.map(([char], i) => ({ id: `char-${i + 1}`, char })),
        },
        grading: { characters: Object.fromEntries(data.SYM.chars.map(([char, symmetric], i) => [`char-${i + 1}`, {
          symmetric,
          explanation: symmetric ? `“${char}”左右两边大致一样，竖着中间一折能重合（字体会有一点点差别）。`
            : `“${char}”左右两边不一样，折过去不能重合。`,
        }])) },
      };
    }
    return undefined;
  };
}

module.exports = { createMathConverter };
