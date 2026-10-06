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

  document.addEventListener("pointerdown", function (event) {
    tap(controlFor(event.target));
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") tap(controlFor(event.target));
  }, true);
})();
