(function () {
  if (window.__PTD_WEB_HAPTICS_READY) return;
  window.__PTD_WEB_HAPTICS_READY = true;

  function tap(target) {
    if (!target || target.disabled) return;
    try {
      if (window.PTDHaptics && typeof window.PTDHaptics.tap === "function") return;
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (_) {}
  }

  document.addEventListener("pointerup", function (event) {
    var target = event.target;
    var control = target && target.closest
      ? target.closest("button,a,[role='button'],.btn,.chip,.tf,.tool,.hudbtn")
      : null;
    tap(control);
  }, true);
})();
