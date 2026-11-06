// activatedElement is different from document.activeElement -- the latter seems to be reserved
// mostly for input elements. This mechanism allows us to decide whether to scroll a div or to
// scroll the whole document.
let activatedElement = null;

// Previously, the main scrolling element was document.body. If the "experimental web platform
// features" flag is enabled, then we need to use document.scrollingElement instead. There's an
// explanation in #2168: https://github.com/philc/vimium/pull/2168#issuecomment-236488091

const getScrollingElement = () =>
  getSpecialScrollingElement() || document.scrollingElement || document.body;

// Return 0, -1 or 1: the sign of the argument.
// NOTE(smblott; 2014/12/17) We would like to use Math.sign(). However, according to this site
// (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/sign)
// Math.sign() was only introduced in Chrome 38. This caused problems in R1.48 for users with old
// Chrome installations. We can replace this with Math.sign() at some point.
// TODO(philc): 2020-04-28: now we can make this replacement.
const getSign = function (val) {
  if (!val) {
    return 0;
  } else {
    if (val < 0) {
      return -1;
    } else {
      return 1;
    }
  }
};

const scrollProperties = {
  x: {
    axisName: "scrollLeft",
    max: "scrollWidth",
    viewSize: "clientWidth",
  },
  y: {
    axisName: "scrollTop",
    max: "scrollHeight",
    viewSize: "clientHeight",
  },
};

// Translate a scroll request into a number (which will be interpreted by `scrollBy` as a relative
// amount, or by `scrollTo` as an absolute amount). :direction must be "x" or "y". :amount may be
// either a number (in which case it is simply returned) or a string. If :amount is a string, then
// it is either "max" (meaning the height or width of element), or "viewSize". In both cases, we
// look up and return the requested amount, either in `element` or in `window`, as appropriate.
const getDimension = function (el, direction, amount) {
  if (Utils.isString(amount)) {
    const name = amount;
    // the clientSizes of the body are the dimensions of the entire page, but the viewport should
    // only be the part visible through the window
    if ((name === "viewSize") && (el === getScrollingElement())) {
      // TODO(smblott) Should we not be returning the width/height of element, here?
      return (direction === "x") ? globalThis.innerWidth : globalThis.innerHeight;
    } else {
      return el[scrollProperties[direction][name]];
    }
  } else {
    return amount;
  }
};

// Perform a scroll. Return true if we successfully scrolled by any amount, and false otherwise.
const performScroll = function (element, direction, amount, behavior) {
  const axisName = scrollProperties[direction].axisName;
  const before = element[axisName];
  if (element.scrollBy) {
    // "smooth" hands the animation to Chromium's compositor; "instant" is the jump. Every caller
    // that only asks whether an element scrolls passes neither, and must not animate.
    const scrollArg = { behavior: behavior || "instant" };
    scrollArg[direction === "x" ? "left" : "top"] = amount;
    element.scrollBy(scrollArg);
  } else {
    element[axisName] += amount;
  }
  return element[axisName] !== before;
};

// Test whether `element` should be scrolled. E.g. hidden elements should not be scrolled.
const shouldScroll = function (element, direction) {
  const computedStyle = globalThis.getComputedStyle(element);
  // Elements with `overflow: hidden` must not be scrolled.
  if (computedStyle.getPropertyValue(`overflow-${direction}`) === "hidden") {
    return false;
  }
  // Elements which are not visible should not be scrolled.
  if (["hidden", "collapse"].includes(computedStyle.getPropertyValue("visibility"))) {
    return false;
  }
  if (computedStyle.getPropertyValue("display") === "none") {
    return false;
  }
  return true;
};

// Test whether element does actually scroll in the direction required when asked to do so. Due to
// chrome bug 110149, scrollHeight and clientHeight cannot be used to reliably determine whether an
// element will scroll. Instead, we scroll the element by 1 or -1 and see if it moved (then put it
// back). :factor is the factor by which :scrollBy and :scrollTo will later scale the scroll amount.
// :factor can be negative, so we need it here in order to decide whether we should test a forward
// scroll or a backward scroll.
// Bug last verified in Chrome 38.0.2125.104.
const doesScroll = function (element, direction, amount, factor) {
  // amount is treated as a relative amount, which is correct for relative scrolls. For absolute
  // scrolls (only gg, G, and friends), amount can be either a string ("max" or "viewSize") or zero.
  // In the former case, we're definitely scrolling forwards, so any positive value will do for
  // delta. In the latter, we're definitely scrolling backwards, so a delta of -1 will do. For
  // absolute scrolls, factor is always 1.
  let delta = (factor * getDimension(element, direction, amount)) || -1;
  delta = getSign(delta); // 1 or -1
  return performScroll(element, direction, delta) && performScroll(element, direction, -delta);
};

const isScrollableElement = function (element, direction, amount, factor) {
  if (direction == null) direction = "y";
  if (amount == null) amount = 1;
  if (factor == null) factor = 1;
  return doesScroll(element, direction, amount, factor) && shouldScroll(element, direction);
};

// From element and its parents, find the first which we should scroll and which does scroll.
const findScrollableElement = function (element, direction, amount, factor) {
  while (
    (element !== getScrollingElement()) && !isScrollableElement(element, direction, amount, factor)
  ) {
    element = DomUtils.getContainingElement(element) || getScrollingElement();
  }
  return element;
};

// On some pages, the scrolling element is not actually scrollable. Here, we search the document for
// the largest visible element which does scroll vertically. This is used to initialize
// activatedElement. See #1358.
const firstScrollableElement = function (element = null) {
  let child;
  if (!element) {
    const scrollingElement = getScrollingElement();
    if (doesScroll(scrollingElement, "y", 1, 1) || doesScroll(scrollingElement, "y", -1, 1)) {
      return scrollingElement;
    } else {
      element = document.body || getScrollingElement();
    }
  }

  if (doesScroll(element, "y", 1, 1) || doesScroll(element, "y", -1, 1)) {
    return element;
  } else {
    // children = children.filter (c) -> c.rect # Filter out non-visible elements.
    const children = Array.from(element.children)
      .map((c) => ({ "element": c, "rect": DomUtils.getVisibleClientRect(c) }))
      .filter((child) => child.rect); // Filter out non-visible elements.
    children.map((child) => child.area = child.rect.width * child.rect.height);
    for (child of children.sort((a, b) => b.area - a.area)) { // Largest to smallest by visible area.
      const el = firstScrollableElement(child.element);
      if (el) {
        return el;
      }
    }
    return null;
  }
};

const checkVisibility = function (element) {
  // If the activated element has been scrolled completely offscreen, then subsequent changes in its
  // scroll position will not provide any more visual feedback to the user. Therefore, we deactivate
  // it so that subsequent scrolls affect the parent element.
  const rect = activatedElement.getBoundingClientRect();
  if (
    (rect.bottom < 0) || (rect.top > globalThis.innerHeight) || (rect.right < 0) ||
    (rect.left > globalThis.innerWidth)
  ) {
    return activatedElement = element;
  }
};

// A smooth scroll is Chromium's own, animated on the compositor thread: it keeps the page's frame
// rate whatever the page's own scripts are doing. The requestAnimationFrame loop this replaces ran
// on the page's main thread, and stepped exactly when a heavy page was working.

// CoreScroller contains the core function (scroll) and logic for relative scrolls. All scrolls are
// ultimately translated to relative scrolls. CoreScroller is not exported.
const CoreScroller = {
  // Scroll element by a relative amount (a number) in some direction.
  scroll(element, direction, amount) {
    if (!amount) {
      return;
    }
    // Jump scrolling is the page's own instant step. Smooth scrolling is asked of the browser,
    // which animates it on the compositor; a second key press retargets the animation already
    // running, so quick taps, held keys and page scrolls glide into one another.
    performScroll(element, direction, amount, Settings.get("smoothScroll") ? "smooth" : "instant");
    checkVisibility(element);
  },
};

// Scroller contains the two main scroll functions which are used by clients.
const Scroller = {
  init() {
    const handler = { _name: "scroller/active-element" };
    // Only Chrome has a DOMActivate event. On Firefox, we must listen for click. See #3287.
    const eventName = Utils.isFirefox() ? "click" : "DOMActivate";
    handler[eventName] = (event) =>
      handlerStack.alwaysContinueBubbling(function () {
        // If event.path is present, the true event taget (potentially inside a Shadow DOM inside
        // event.target) can be found as its first element.
        // NOTE(mrmr1993): event.path has been renamed to event.deepPath in the spec, but this
        // change is not yet implemented by Chrome.
        const path = event.deepPath || event.path;
        return activatedElement = path ? path[0] : event.target;
      });
    handlerStack.push(handler);
    this.reset();
  },

  reset() {
    activatedElement = null;
  },

  // scroll the active element in :direction by :amount * :factor.
  // :factor is needed because :amount can take on string values, which scrollBy converts to element
  // dimensions.
  scrollBy(direction, amount, factor) {
    // if this is called before domReady, just use the window scroll function
    if (factor == null) {
      factor = 1;
    }
    if (!getScrollingElement() && amount instanceof Number) {
      if (direction === "x") {
        globalThis.scrollBy(amount, 0);
      } else {
        globalThis.scrollBy(0, amount);
      }
      return;
    }

    if (!activatedElement) {
      activatedElement = (getScrollingElement() && firstScrollableElement()) ||
        getScrollingElement();
    }
    if (!activatedElement) {
      return;
    }

    const element = findScrollableElement(activatedElement, direction, amount, factor);
    const elementAmount = factor * getDimension(element, direction, amount);
    return CoreScroller.scroll(element, direction, elementAmount);
  },

  scrollTo(direction, pos) {
    if (!activatedElement) {
      activatedElement = (getScrollingElement() && firstScrollableElement()) ||
        getScrollingElement();
    }
    if (!activatedElement) {
      return;
    }

    const element = findScrollableElement(activatedElement, direction, pos, 1);
    const amount = getDimension(element, direction, pos) -
      element[scrollProperties[direction].axisName];
    return CoreScroller.scroll(element, direction, amount);
  },

  // Is element scrollable and not the activated element?
  isScrollableElement(element) {
    if (!activatedElement) {
      activatedElement = (getScrollingElement() && firstScrollableElement()) ||
        getScrollingElement();
    }
    return (element !== activatedElement) && isScrollableElement(element);
  },

  // Scroll the top, bottom, left and right of element into view. The is used by visual mode to
  // ensure the focus remains visible.
  scrollIntoView(element) {
    if (!activatedElement) {
      activatedElement = getScrollingElement() && firstScrollableElement();
    }
    const rects = element.getClientRects();
    const rect = rects ? rects[0] : undefined;
    if (rect) {
      // Scroll y axis.
      let amount;
      if (rect.bottom < 0) {
        amount = rect.bottom - Math.min(rect.height, globalThis.innerHeight);
        element = findScrollableElement(element, "y", amount, 1);
        CoreScroller.scroll(element, "y", amount);
      } else if (globalThis.innerHeight < rect.top) {
        amount = rect.top + Math.min(rect.height - globalThis.innerHeight, 0);
        element = findScrollableElement(element, "y", amount, 1);
        CoreScroller.scroll(element, "y", amount);
      }

      // Scroll x axis.
      if (rect.right < 0) {
        amount = rect.right - Math.min(rect.width, globalThis.innerWidth);
        element = findScrollableElement(element, "x", amount, 1);
        CoreScroller.scroll(element, "x", amount);
      } else if (globalThis.innerWidth < rect.left) {
        amount = rect.left + Math.min(rect.width - globalThis.innerWidth, 0);
        element = findScrollableElement(element, "x", amount, 1);
        CoreScroller.scroll(element, "x", amount);
      }
    }
  },
};

const getSpecialScrollingElement = function () {
  const selector = specialScrollingElementMap[globalThis.location.host];
  if (selector) {
    return document.querySelector(selector);
  }
};

const specialScrollingElementMap = {
  "twitter.com": "div.permalink-container div.permalink[role=main]",
  "reddit.com": "#overlayScrollContainer",
  "new.reddit.com": "#overlayScrollContainer",
  "www.reddit.com": "#overlayScrollContainer",
  "web.telegram.org": ".MessageList",
};

globalThis.Scroller = Scroller;
