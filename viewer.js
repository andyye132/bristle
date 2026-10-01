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
  // zoom is the field of view across the canvas's shorter side, so a wide canvas shows more rather than cropping top and bottom
  var fit = Math.max(1, cameraInternal.aspect_ratio);
  var w = camera.zoom / fit;
  var h = camera.zoom * cameraInternal.aspect_ratio / fit;
  var px = cameraInternal.xfrac - 1;
  var perspective = [w, 0, px, 0, 0, -h, 0, 0, 0, 0, a, b, 0, 0, 1, 0];
  // orbit around the middle of the camera path unless following the current frame
  const anchor = (!camera.follow && data.center) ? data.center : [pose[0][3], pose[1][3], pose[2][3]];
  const follow_position = matT([-anchor[0], -anchor[1], -anchor[2]]);
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

let dirty = true;

// Colour of the 3D viewport; the page can override it before the first draw.
let viewerBackground = [0.95, 0.95, 0.95];

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

const sceneLoad = { id: 0, abort: null };

function freeScene(d) {
  if (!d || !d.poses) return;
  for (const t of [...d.rgb, ...d.depth, ...d.video_rgb, d.live]) if (t) gl.deleteTexture(t);
  gl.deleteBuffer(d.path.vb);
  if (d._endpointBuf) gl.deleteBuffer(d._endpointBuf);
}

// Resolves true once the scene is ready to draw, false if a newer loadScene() call replaced it.
// View settings (state) survive the switch; only the orbit camera and the frame are reset.
async function loadScene(packedurl, onProgress) {
  const id = ++sceneLoad.id;
  if (sceneLoad.abort) sceneLoad.abort.abort();
  sceneLoad.abort = new AbortController();
  freeScene(data); data = false; dirty = true;
  resetState(camera, parameterSpec.camera);
  state.frame = 0;
  let d, images;
  try {
    const packed = await fetchPacked(packedurl, onProgress, sceneLoad.abort.signal);
    d = JSON.parse(await packed['data.json'].text());
    // The trajectory NPZs carry no images, so the converter packs a blank RGB frame per keyframe
    // (a ~1 KB PNG). Skip those; colour then comes from the synced video (captureVideoFrame).
    images = await Promise.all(d.poses.flatMap((_, i) => {
      const rgb = packed[`rgb_${pad5(i)}.png`];
      return [rgb && rgb.size > 4096 ? decodeImage(rgb) : null, decodeImage(packed[`depthrgb_${pad5(i)}.png`])];
    }));
  } catch (e) {
    if (id !== sceneLoad.id) return false;
    throw e;
  }
  if (id !== sceneLoad.id) return false;
  d.depth_scale = 20;
  d.rgb = []; d.depth = []; d.video_rgb = []; d.live = null;
  for (let i = 0; i < d.poses.length; i++) {
    if (images[2*i]) d.rgb[i] = makeTexture(images[2*i], gl.LINEAR);
    d.depth[i] = makeTexture(images[2*i + 1], gl.NEAREST);
  }
  d.path = buildPathBuffer(d.poses);
  d.center = [0, 1, 2].map(k => d.poses.reduce((sum, p) => sum + p[k][3], 0) / d.poses.length);
  data = d; dirty = true;
  return true;
}

function decodeImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('undecodable image in packed file')); };
    image.src = url;
  });
}

function uploadTexture(t, source) {
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

function makeTexture(source, filter) {
  const t = gl.createTexture();
  uploadTexture(t, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  t.ready = true;
  return t;
}

// Copy what the synced <video> is showing into keyframe i's colour. The current frame always gets
// it (data.live); every_nth frames are also kept so the accumulated cloud fills in as the clip plays.
let videoUnreadable = false;
function captureVideoFrame(i) {
  const v = syncVideo;
  if (videoUnreadable || v.seeking || v.readyState < 2) return false;
  try {
    if (data.live) uploadTexture(data.live, v); else data.live = makeTexture(v, gl.LINEAR);
    data.live.frame = i;
    if (i % state.every_nth === 0 && !data.video_rgb[i]) data.video_rgb[i] = makeTexture(v, gl.LINEAR);
  } catch (e) {
    // a video served without CORS headers can't be read into a texture
    videoUnreadable = true; console.log('Video frames unavailable for colour:', e.message);
    return false;
  }
  return true;
}

function colorTexture(i) {
  if (data.rgb[i]) return data.rgb[i];
  if (data.live && data.live.frame === i) return data.live;
  return data.video_rgb[i];
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
  if (!tex || !tex.ready) return;
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
  const rgb = colorTexture(i);
  if (!rgb || !data.depth[i].ready) return;
  const p = programs['cloud'];
  gl.uniform1f(p.uniform.alpha, alpha);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rgb);
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
  gl.clearColor(viewerBackground[0], viewerBackground[1], viewerBackground[2], 1.0);
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
  drawImage(state.frame, colorTexture(state.frame), 1.0);
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

async function fetchPacked(url, onProgress, signal) {
  const results = {};
  const response = await fetch(url, {signal});
  if (response.status !== 200) throw new Error(`HTTP ${response.status} fetching packed scene`);
  const total = Number(response.headers.get('Content-Length'));
  let blob;
  if (onProgress && total && response.body) {
    const reader = response.body.getReader(); const chunks = []; let received = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value); received += value.length; onProgress(Math.min(1, received / total));
    }
    blob = new Blob(chunks);
  } else { blob = await response.blob(); }
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

  // Drive 3D frame from video currentTime
  if (syncVideo && data && data.poses && data.poses.length) {
    const t = syncVideo.currentTime;
    const videoFrame = t * syncFps;
    // Each 3D keyframe = frame_step video frames
    const newFrame = Math.max(0, Math.min(
      Math.floor(videoFrame / syncFrameStep),
      data.poses.length - 1
    ));
    if (newFrame !== state.frame) {
      state.frame = newFrame;
      dirty = true;
    }
    if ((!data.live || data.live.frame !== newFrame) && captureVideoFrame(newFrame)) dirty = true;
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
  // A plain scroll over the canvas scrolls the page; pinch (which arrives as ctrl+wheel) or cmd/ctrl+scroll zooms.
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    zoomView(Math.exp(0.01 * Math.max(-30, Math.min(30, e.deltaY))));
    e.preventDefault();
  }, {passive: false});
}

function zoomView(factor) { camera.distance = Math.max(0.1, Math.min(10, camera.distance * factor)); dirty = true; }
function resetView() { resetState(camera, parameterSpec.camera); dirty = true; }

function resize() {
  if (!canvas.clientWidth || !canvas.clientHeight) return;
  const dp = Math.min(window.devicePixelRatio || 1, 2);
  state.size_factor = dp;
  canvas.width = canvas.clientWidth * dp;
  canvas.height = canvas.clientHeight * dp;
  gl.viewport(0, 0, canvas.width, canvas.height);
  cameraInternal.aspect_ratio = canvas.width / canvas.height;
  dirty = true;
}

function init() {
  canvas = document.getElementById('megaview');
  gl = canvas.getContext('webgl2', {antialias: false, alpha: false});
  if (!gl) return;
  resize();
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const v = initShaders(vertexShaders, gl.VERTEX_SHADER);
  const f = initShaders(fragmentShaders, gl.FRAGMENT_SHADER);
  initPrograms(v, f, programs);
  initBuffers(buffers);
  addHandlers(canvas);
  new ResizeObserver(resize).observe(canvas);
  window.requestAnimationFrame(tick);
}

// Runs as soon as the script does (it is included after the canvas), so `gl` exists before the page
// asks for a scene; `gl` stays null when WebGL2 is unavailable.
init();
