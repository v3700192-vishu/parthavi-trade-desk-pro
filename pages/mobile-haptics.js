(function () {
  if (window.__PTD_WEB_HAPTICS_READY) return;
  window.__PTD_WEB_HAPTICS_READY = true;

  var lastTap = 0;
  function tap(target) {
    if (!target || target.disabled) return;
    var now = Date.now();
    if (now - lastTap < 80) return;
    lastTap = now;
    try {
      if (window.PTDHaptics && typeof window.PTDHaptics.tap === "function") {
        window.PTDHaptics.tap();
        return;
      }
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (_) {}
  }

  function controlFor(target) {
    return target && target.closest
      ? target.closest("button,a,[role='button'],.btn,.chip,.tf,.tool,.hudbtn,select,input[type='checkbox'],input[type='radio'],.toggle")
      : null;
  }

  window.PTDHaptics = window.PTDHaptics || {};
  window.PTDHaptics.alert = function (kind) {
    try {
      var native = window.PTDHapticsNative && typeof window.PTDHapticsNative.alert === "function"
        ? window.PTDHapticsNative
        : null;
      if (native) { native.alert(String(kind || "neutral")); return true; }
      if (!navigator.vibrate) return false;
      var pattern = kind === "confirmed" ? [90,60,90,60,160]
        : kind === "bearish" ? [180,80,180]
        : kind === "bullish" ? [90,60,90]
        : [120];
      navigator.vibrate(pattern);
      return true;
    } catch (_) { return false; }
  };

  document.addEventListener("pointerdown", function (event) {
    tap(controlFor(event.target));
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") tap(controlFor(event.target));
  }, true);
})();
