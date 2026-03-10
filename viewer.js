// MegaSaM 3D Viewer — local copy from mega-sam.github.io
// See https://github.com/mega-sam/mega-sam.github.io

let canvas;
let gl;

const vertexShaders = {
xyz_rgba: `#version 300 es
  precision highp float;
  in vec3 xyz;
  in vec4 rgba;
  uniform mat4 camera;
  uniform float point_size;
  uniform float minWidth;
  out vec4 color;
  in float index;
  void main(void) {
    gl_Position = camera * vec4(xyz, 1.0);
    float size = point_size / gl_Position.w;
    color = rgba;
    if (size < minWidth) { color.a *= size / minWidth; size = minWidth; }
    gl_PointSize = size;
  }`,
xy: `#version 300 es
  precision highp float;
  in vec2 xy;
  uniform mat4 camera;
  uniform mat4 pose;
  uniform float frustum_size;
  out vec2 v_uv;
  void main(void) {
    gl_Position = camera * pose * (vec4(frustum_size, frustum_size, frustum_size, 1.0) * vec4(xy, 1.0, 1.0));
    v_uv = xy;
  }`,
depth: `#version 300 es
  precision highp float;
  uniform mat4 camera;
  uniform mat4 pose;
  uniform sampler2D depth;
  uniform float depthscale;
  uniform float point_size;
  uniform int width;
  uniform int height;
  uniform int stride;
  uniform float max_grad;
  out vec2 v_uv;
  float d(vec2 p) {
    vec4 rgba = texture(depth, p);
    return depthscale * (rgba.r + rgba.g/256.0);
  }
  void main(void) {
    int x = gl_VertexID % (width / stride) * stride;
    int y = gl_VertexID / (width / stride) * stride;
    vec2 uv;
    uv.x = (float(x) + 0.5) / float(width);
    uv.y = (float(y) + 0.5) / float(height);
    highp float z = d(uv);
    vec2 dx = vec2(1.0 / float(width), 0.0);
    vec2 dy = vec2(0.0, 1.0 / float(height));
    highp float gx = abs(d(uv + dx) - d(uv - dx));
    highp float gy = abs(d(uv + dy) - d(uv - dy));
    if (gx > max_grad * z || gy > max_grad * z) { z = 0.0; }
    gl_Position = camera * pose * vec4(uv.x * z, uv.y * z, z, 1.0);
    v_uv = uv;
    gl_PointSize = point_size * z / gl_Position[3];
  }`,
linesegment: `#version 300 es
  precision highp float;
  uniform mat4 camera;
  uniform float width;
  uniform float height;
  uniform float lineWidth;
  uniform float minWidth;
  in vec3 xyz0;
  in vec3 xyz1;
  in vec4 rgba;
  out vec4 color;
  in float segmentLength;
  in float index;
  void main(void) {
    vec4 zero4 = vec4(0.0, 0.0, 0.0, 0.0);
    vec4 p0 = camera * vec4(xyz0, 1.0);
    vec4 p1 = camera * vec4(xyz1, 1.0);
    color = rgba;
    if (p0.w < 0.0 || p1.w < 0.0) { gl_Position = zero4; color = zero4; return; }
    float p0w = p0.w; float p1w = p1.w;
    p0 /= p0w; p1 /= p1w;
    float r0 = lineWidth / p0w; float r1 = lineWidth / p1w;
    float r0a = 1.0; float r1a = 1.0;
    if (r0 < minWidth) { r0a = r0 / minWidth; r0 = minWidth; }
    if (r1 < minWidth) { r1a = r1 / minWidth; r1 = minWidth; }
    vec2 viewsize = vec2(width, height);
    vec2 unit = (p1.xy - p0.xy) * viewsize;
    float linelength = length(unit);
    unit /= linelength;
    float theta = asin(clamp((r0 - r1) / linelength, -1.0, 1.0));
    vec4 p; float r;
    float side = float(2*(gl_VertexID % 2) - 1);
    if (gl_VertexID < 2) { p = p0; r = r0; color.a *= r0a; }
    else { p = p1; r = r1; color.a *= r1a; }
    vec2 offset = vec2(-unit.y, unit.x);
    gl_Position = p + vec4((unit * (sin(theta) * r) + offset * cos(theta) * side * r) / viewsize, 0.0, 0.0);
  }`,
}

const fragmentShaders = {
vcolor: `#version 300 es
  precision highp float;
  in vec4 color;
  out vec4 outColor;
  void main(void) { outColor = color; }`,
tex: `#version 300 es
  precision highp float;
  in highp vec2 v_uv;
  uniform sampler2D image;
  uniform float alpha;
  out vec4 color;
  void main(void) { color = texture(image, v_uv); color.a *= alpha; }`,
roundpoint: `#version 300 es
  precision highp float;
  in vec4 color;
  out vec4 outColor;
  void main(void) {
    vec2 d = 2.0*gl_PointCoord - vec2(1.0, 1.0);
    if (dot(d, d) > 1.0) { discard; }
    outColor = color;
  }`
}

const programs = {
  screen: ['xy', 'tex'],
  cloud: ['depth', 'tex'],
  linequads: ['linesegment', 'vcolor'],
  roundpoints: ['xyz_rgba', 'roundpoint'],
};

function gridBuffer() {
  const s = 100; const p = []; const y = 2;
  for (let i = -s; i <= s; i++) {
    for (let j = -s; j <= s; j++) {
      p.push(i, y, j, i+1, y, j);
      p.push(i, y, j, i, y, j+1);
    }
  }
  return p;
}

const buffers = {
  frustum: [0,0,0, 0,0,1, 0,0,0, 1,0,1, 0,0,0, 0,1,1, 0,0,0, 1,1,1,
            0,0,1, 1,0,1, 1,0,1, 1,1,1, 1,1,1, 0,1,1, 0,1,1, 0,0,1],
  frustum_points: [0,0,0, 0,0,1, 0,1,1, 1,0,1, 1,1,1],
  corners: [0,0, 1,0, 0,1, 1,1],
  grid: gridBuffer(),
};

const cameraInternal = { near: .01, far: 100, aspect_ratio: 1, xfrac: 1 };

function cameraMatrix(camera, pose) {
  var d = 1 / (cameraInternal.far - cameraInternal.near);
  var a = (cameraInternal.near + cameraInternal.far) * d;
  var b = -2 * (cameraInternal.near * cameraInternal.far) * d;
  var w = camera.zoom;
  var h = camera.zoom * cameraInternal.aspect_ratio;
  var px = cameraInternal.xfrac - 1;
  var perspective = [w, 0, px, 0, 0, -h, 0, 0, 0, 0, a, b, 0, 0, 1, 0];
  const follow_position = matT([-pose[0][3], -pose[1][3], -pose[2][3]]);
  let follow_rotation;
  if (camera.follow_rotation) {
    follow_rotation = [
      pose[0][0], pose[1][0], pose[2][0], 0,
      pose[0][1], pose[1][1], pose[2][1], 0,
      pose[0][2], pose[1][2], pose[2][2], 0,
      0, 0, 0, 1];
  } else { follow_rotation = matI(); }
  return matCompose(perspective,
    matT([0, camera.elevation * camera.distance, camera.distance]),
    matRx(camera.rx), matRy(camera.ry),
    matT([0, 0, -camera.forward]),
    follow_rotation, follow_position);
}

function poseMatrix(data, i) {
  const intrinsics = data.intrinsics[i];
  const px = intrinsics[2]; const py = intrinsics[3];
  const ifx = 1.0 / intrinsics[0]; const ify = 1.0 / intrinsics[1];
  const tex_to_cam = [ifx, 0, -px*ifx, 0, 0, ify, -py*ify, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const cp = data.poses[i];
  const pose = [
    cp[0][0], cp[0][1], cp[0][2], cp[0][3],
    cp[1][0], cp[1][1], cp[1][2], cp[1][3],
    cp[2][0], cp[2][1], cp[2][2], cp[2][3],
    0, 0, 0, 1];
  return matCompose(pose, tex_to_cam);
}

function matCompose() {
  if (arguments.length == 0) return matI();
  var m = arguments[0];
  for (var i = 1; i < arguments.length; i++) m = matMM(m, arguments[i]);
  return m;
}
function matMM(a, b) {
  var c = [];
  for (var j = 0; j < 4; j++) for (var i = 0; i < 4; i++) {
    var k = j*4;
    c.push(a[k]*b[i] + a[k+1]*b[i+4] + a[k+2]*b[i+8] + a[k+3]*b[i+12]);
  }
  return c;
}
function vec4Lerp(a, b, p) { const q=1-p; return [a[0]*q+b[0]*p, a[1]*q+b[1]*p, a[2]*q+b[2]*p, a[3]*q+b[3]*p]; }
function matRx(t) { const c=Math.cos(t),s=Math.sin(t); return [1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1]; }
function matRy(t) { const c=Math.cos(t),s=Math.sin(t); return [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]; }
function matScale(t) { return [t,0,0,0, 0,t,0,0, 0,0,t,0, 0,0,0,1]; }
function matI() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function matT([x,y,z]) { return [1,0,0,x, 0,1,0,y, 0,0,1,z, 0,0,0,1]; }

function initShaders(shaders, type) {
  const compiled = {};
  for (let i in shaders) {
    const s = gl.createShader(type);
    gl.shaderSource(s, shaders[i]);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.log('Compiling ' + i, gl.getShaderInfoLog(s));
    compiled[i] = s;
  }
  return compiled;
}

function initPrograms(vs, fs, progs) {
  for (let i in progs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs[progs[i][0]]);
    gl.attachShader(p, fs[progs[i][1]]);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.log('Linking ' + i, gl.getProgramInfoLog(p));
    const attribute = {}, uniform = {};
    let n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let j = 0; j < n; ++j) { const info = gl.getActiveAttrib(p, j); const loc = gl.getAttribLocation(p, info.name); if (loc >= 0) attribute[info.name] = loc; }
    n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let j = 0; j < n; ++j) { const info = gl.getActiveUniform(p, j); const loc = gl.getUniformLocation(p, info.name); if (loc) uniform[info.name] = loc; }
    progs[i].name = i; progs[i].program = p; progs[i].attribute = attribute; progs[i].uniform = uniform;
  }
}

function initBuffer(b) {
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  const d = new Float32Array(b);
  gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
  b.vb = vb; b.data = d;
}
function initBuffers(bufs) { for (const b in bufs) initBuffer(bufs[b]); }

let remaining_to_load = 0, total_to_load = 0, dirty = true;
function updateLoading() { if (remaining_to_load <= 0) { const el = document.getElementById('loading-3d') || document.getElementById('loading'); if (el) el.style.display = 'none'; } }

function buildPathBuffer(poses) {
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  const floats = new Float32Array(poses.length * 3);
  let index = 0;
  for (const p of poses) { floats[index]=p[0][3]; floats[index+1]=p[1][3]; floats[index+2]=p[2][3]; index+=3; }
  gl.bufferData(gl.ARRAY_BUFFER, floats, gl.STATIC_DRAW);
  return {vb: vb, n: poses.length};
}

function pad5(i) { return i.toString().padStart(5, '0'); }

async function loadScene(packedurl) {
  const loadEl = document.getElementById('loading-3d') || document.getElementById('loading');
  if (loadEl) loadEl.style.display = 'block';
  data = {};
  resetState(state, parameterSpec.state);
  resetState(camera, parameterSpec.camera);
  const packed_data = await fetchPacked(packedurl);
  data = JSON.parse(await packed_data['data.json'].text());
  data.rgb = []; data.depth = []; data.depth_scale = 20;
  data.path = buildPathBuffer(data.poses);
  for (let i = 0; i < data.poses.length; i++) {
    data.rgb[i] = loadTexture(packed_data[`rgb_${pad5(i)}.png`]);
    data.depth[i] = loadDepth(packed_data[`depthrgb_${pad5(i)}.png`]);
  }
  const infoEl = document.getElementById('info');
  if (infoEl) infoEl.textContent = `Loaded: ${data.poses.length} frames`;
}

function loadTexture(blob) {
  const t = gl.createTexture(); const url = URL.createObjectURL(blob);
  const image = new Image();
  image.onload = function() {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    t.ready = true; URL.revokeObjectURL(url); dirty = true; remaining_to_load--; updateLoading();
  };
  total_to_load++; remaining_to_load++; image.src = url; return t;
}

function loadDepth(blob) {
  const t = gl.createTexture(); const url = URL.createObjectURL(blob);
  const image = new Image();
  image.onload = function() {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    t.ready = true; URL.revokeObjectURL(url); dirty = true; remaining_to_load--; updateLoading();
  };
  total_to_load++; remaining_to_load++; updateLoading(); image.src = url; return t;
}

function prepareDrawFrustum(size_factor) {
  const p = programs['linequads']; program(p);
  gl.uniform1f(p.uniform.width, canvas.width); gl.uniform1f(p.uniform.height, canvas.height);
  gl.uniform1f(p.uniform.minWidth, size_factor);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.frustum.vb);
  gl.enableVertexAttribArray(p.attribute.xyz0); gl.enableVertexAttribArray(p.attribute.xyz1);
  gl.vertexAttribDivisor(p.attribute.xyz0, 1); gl.vertexAttribDivisor(p.attribute.xyz1, 1);
  if (p.attribute.segmentLength !== undefined) gl.vertexAttrib1f(p.attribute.segmentLength, 0.0);
  if (p.attribute.index !== undefined) gl.vertexAttrib1f(p.attribute.index, 0.0);
  gl.vertexAttribPointer(p.attribute.xyz0, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribPointer(p.attribute.xyz1, 3, gl.FLOAT, false, 24, 12);
}

function drawFrustum(camera_matrix, i, color, width) {
  const p = programs['linequads'];
  gl.uniformMatrix4fv(p.uniform.camera, true, matCompose(camera_matrix, poseMatrix(data, i), matScale(state.frustum_size)));
  gl.vertexAttrib4fv(p.attribute.rgba, color);
  gl.uniform1f(p.uniform.lineWidth, width);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 8);
}

function drawPath(camera_matrix, color, size_factor, width) {
  const p = programs['linequads'];
  gl.uniformMatrix4fv(p.uniform.camera, true, camera_matrix);
  gl.vertexAttrib4fv(p.attribute.rgba, color);
  gl.uniform1f(p.uniform.minWidth, size_factor);
  gl.uniform1f(p.uniform.lineWidth, width);
  gl.bindBuffer(gl.ARRAY_BUFFER, data.path.vb);
  gl.vertexAttribPointer(p.attribute.xyz0, 3, gl.FLOAT, false, 12, 0);
  gl.vertexAttribPointer(p.attribute.xyz1, 3, gl.FLOAT, false, 12, 12);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.path.n - 1);
}

function prepareDrawImage(camera_matrix) {
  const p = programs['screen']; program(p);
  gl.uniformMatrix4fv(p.uniform.camera, true, camera_matrix);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.corners.vb);
  gl.enableVertexAttribArray(p.attribute.xy);
  gl.vertexAttribPointer(p.attribute.xy, 2, gl.FLOAT, false, 8, 0);
  gl.uniform1f(p.uniform.frustum_size, state.frustum_size * 1.001);
}

function drawImage(frame, tex, alpha) {
  if (!tex.ready) return;
  const p = programs['screen'];
  gl.uniformMatrix4fv(p.uniform.pose, true, poseMatrix(data, frame));
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(p.uniform.image, 0); gl.uniform1f(p.uniform.alpha, alpha);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, buffers.corners.length / 2);
}

function prepareDrawPoints(camera_matrix, stride, size, size_factor) {
  const p = programs['cloud']; program(p);
  gl.uniformMatrix4fv(p.uniform.camera, true, camera_matrix);
  gl.uniform1i(p.uniform.image, 0); gl.uniform1i(p.uniform.depth, 1);
  gl.uniform1f(p.uniform.depthscale, data.depth_scale);
  gl.uniform1f(p.uniform.max_grad, state.z_clamp * 2);
  gl.uniform1f(p.uniform.point_size, size * size_factor);
  gl.uniform1i(p.uniform.width, data.width); gl.uniform1i(p.uniform.height, data.height);
  gl.uniform1i(p.uniform.stride, stride);
}

function drawPoints(i, stride, alpha) {
  if (!data.rgb[i].ready || !data.depth[i].ready) return;
  const p = programs['cloud'];
  gl.uniform1f(p.uniform.alpha, alpha);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, data.rgb[i]);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, data.depth[i]);
  gl.uniformMatrix4fv(p.uniform.pose, true, poseMatrix(data, i));
  const w = data.width, h = data.height;
  gl.drawArrays(gl.POINTS, 0, (w/stride|0) * (h/stride|0));
}

function program(p) {
  gl.useProgram(p.program);
  for (const a of Object.values(p.attribute)) { gl.disableVertexAttribArray(a); gl.vertexAttribDivisor(a, 0); }
}

function* other_frames() {
  const step = state.every_nth || 1;
  for (let i = 0; i < data.poses.length; i += step) {
    yield [i, 1.0];
  }
}

function draw(state) {
  gl.clearColor(0.95, 0.95, 0.95, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!data || !data.poses) return;
  const size_factor = state.size_factor;
  const camera_matrix = cameraMatrix(camera, data.poses[state.camera_frame]);

  // Draw point clouds
  if (state.show_all_points) {
    prepareDrawPoints(camera_matrix, state.stride, state.point_size, size_factor);
    for (const [i] of other_frames()) drawPoints(i, state.stride, 0.8);
  }
  prepareDrawPoints(camera_matrix, 1, state.point_size, size_factor);
  drawPoints(state.frame, 1, 1.0);

  // Draw frustums
  prepareDrawFrustum(size_factor);
  if (state.show_all_frusta) {
    const n = data.poses.length;
    for (const [i] of other_frames()) {
      if (i !== state.frame) {
        const t = i / (n - 1);
        drawFrustum(camera_matrix, i, [0.4+0.6*t, 0.4*(1-t), 0.8*(1-t), 0.6], 1.0 * size_factor);
      }
    }
  }
  drawFrustum(camera_matrix, state.frame, [1, 0, 0, 1], 2.0 * size_factor);
  drawPath(camera_matrix, [0.5, 0.5, 0.5, 1], size_factor, 1.5 * size_factor);

  // Draw endpoint markers (goal + floor point)
  if (data.goal_position) {
    drawEndpointMarker(camera_matrix, data.goal_position, [0.0, 1.0, 0.3, 1.0], 12.0 * size_factor); // green = goal
  }
  if (data.floor_point) {
    drawEndpointMarker(camera_matrix, data.floor_point, [1.0, 0.3, 0.0, 1.0], 14.0 * size_factor); // orange = floor
  }

  // Draw images on frustums
  prepareDrawImage(camera_matrix);
  drawImage(state.frame, data.rgb[state.frame], 1.0);
}

function drawEndpointMarker(camera_matrix, pos, color, size) {
  const p = programs['roundpoints'];
  program(p);
  gl.uniform1f(p.uniform.point_size, size);
  gl.uniform1f(p.uniform.minWidth, 2.0);
  gl.uniformMatrix4fv(p.uniform.camera, true, camera_matrix);
  gl.vertexAttrib4fv(p.attribute.rgba, color);
  // Create a temporary buffer with just the endpoint position
  if (!data._endpointBuf) data._endpointBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, data._endpointBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(p.attribute.xyz);
  gl.vertexAttribPointer(p.attribute.xyz, 3, gl.FLOAT, false, 0, 0);
  if (p.attribute.index !== undefined) gl.vertexAttrib1f(p.attribute.index, 0.0);
  gl.drawArrays(gl.POINTS, 0, 1);
}

function rgba(text) {
  function f(a, b) { return (parseInt(a, 16) * 16 + (b ? parseInt(b, 16) : parseInt(a, 16))) / 255; }
  if (text[0] === '#') text = text.slice(1);
  if (text.length === 3) return [f(text[0]), f(text[1]), f(text[2]), 1];
  return [f(text[0], text[1]), f(text[2], text[3]), f(text[4], text[5]), 1];
}

const parameterSpec = {
  camera: { distance: 1.5, forward: 0, elevation: 0.2, zoom: 1, follow: false, follow_rotation: true, rx: 0.5, ry: 0 },
  state: {
    draw_frustum: true, show_points: 'points', points_alpha: 1.0, stride: 2,
    point_size: 4, frustum_size: 0.25, z_clamp: 0.02, every_nth: 5,
    playing: true, fps: 10, frame: 0, camera_frame: 0,
    background: 0.95, frustum_width: 2, show_all_frusta: true, show_all_points: false,
    size_factor: 1,
  },
};

async function fetchPacked(url) {
  const results = {};
  const response = await fetch(url);
  if (response.status !== 200) { console.log('Error:', response.status); return results; }
  const blob = await response.blob();
  const prefix_size = new DataView(await blob.slice(0, 8).arrayBuffer()).getUint32(0, true);
  const json = JSON.parse(await blob.slice(8, prefix_size).text());
  for (const [key, [start, end, content_type]] of Object.entries(json)) {
    results[key] = blob.slice(start + prefix_size, end + prefix_size, content_type);
  }
  return results;
}

function resetState(target, spec) { for (const key in spec) target[key] = spec[key]; }

const state = {}; resetState(state, parameterSpec.state);
const camera = {}; resetState(camera, parameterSpec.camera);
let data = false;
let frame_time = Date.now();

// Sync source: set by the page to drive 3D from video time
let syncVideo = null;
let syncFrameStep = 4;
let syncFps = 29.97;

function tick() {
  window.requestAnimationFrame(tick);
  if (remaining_to_load > 0) return;

  // Drive 3D frame from video currentTime
  if (syncVideo && data && data.poses && data.poses.length) {
    const t = syncVideo.currentTime;
    const videoFrame = t * syncFps;
    // Each 3D keyframe = frame_step video frames
    const newFrame = Math.min(
      Math.floor(videoFrame / syncFrameStep),
      data.poses.length - 1
    );
    if (newFrame !== state.frame) {
      state.frame = Math.max(0, newFrame);
      dirty = true;
    }
  }

  if (dirty) { dirty = false; state.camera_frame = camera.follow ? state.frame : 0; draw(state); }
}

function addHandlers(canvas) {
  let dragging = false, ox, oy, rx, ry;
  const speed = Math.PI / 500;
  canvas.addEventListener("pointerdown", (e) => { dragging=true; ox=e.clientX; oy=e.clientY; rx=camera.rx; ry=camera.ry; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => { if (dragging) { camera.rx=rx+(e.clientY-oy)*speed; camera.ry=ry-(e.clientX-ox)*speed; dirty=true; } });
  canvas.addEventListener("pointerup", () => dragging=false);
  canvas.addEventListener("pointercancel", () => dragging=false);
  canvas.addEventListener('wheel', (e) => { camera.distance = Math.max(0.1, Math.min(10, camera.distance - 0.001 * e.wheelDeltaY)); dirty=true; e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === ' ') { state.playing = !state.playing; dirty=true; e.preventDefault(); }
    if (e.key === 'ArrowLeft') { state.playing=false; state.frame=(state.frame-1+data.poses.length)%data.poses.length; dirty=true; e.preventDefault(); }
    if (e.key === 'ArrowRight') { state.playing=false; state.frame=(state.frame+1)%data.poses.length; dirty=true; e.preventDefault(); }
  });
}

function resize() {
  const dp = window.devicePixelRatio;
  state.size_factor = dp;
  canvas.width = canvas.clientWidth * dp;
  canvas.height = canvas.clientHeight * dp;
  gl.viewport(0, 0, canvas.width, canvas.height);
  cameraInternal.aspect_ratio = canvas.width / canvas.height;
  dirty = true;
}

async function init() {
  canvas = document.getElementById('megaview');
  gl = canvas.getContext('webgl2', {antialias: false, alpha: false});
  if (!gl) { const el = document.getElementById('loading-3d'); if (el) el.textContent = 'WebGL2 not supported'; return; }
  resize();
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const v = initShaders(vertexShaders, gl.VERTEX_SHADER);
  const f = initShaders(fragmentShaders, gl.FRAGMENT_SHADER);
  initPrograms(v, f, programs);
  initBuffers(buffers);
  addHandlers(canvas);
  window.addEventListener('resize', resize);
  window.requestAnimationFrame(tick);

}

window.addEventListener('load', init);
