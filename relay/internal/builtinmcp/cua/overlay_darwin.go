//go:build darwin && desktop_cua && cgo

package cua

/*
#cgo CFLAGS: -x objective-c -fobjc-arc -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Cocoa -framework Carbon -framework QuartzCore
#include <Carbon/Carbon.h>
#include <Cocoa/Cocoa.h>
#include <QuartzCore/QuartzCore.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

extern void synapseDarwinOverlayHotkeyCallback(uintptr_t controllerID, int action);

enum {
    SynapseDarwinHotkeyTerminate = 1,
    SynapseDarwinHotkeyDisable = 2,
};

@interface SynapseOverlayUpdatePayload : NSObject
@property(nonatomic, copy) NSString* runtimeSessionID;
@property(nonatomic, copy) NSString* actionName;
@property(nonatomic, copy) NSString* labelText;
@property(nonatomic, copy) NSString* direction;
@property(nonatomic) NSInteger screenX;
@property(nonatomic) NSInteger screenY;
@property(nonatomic) NSInteger startScreenX;
@property(nonatomic) NSInteger startScreenY;
@property(nonatomic) NSInteger endScreenX;
@property(nonatomic) NSInteger endScreenY;
@end

@implementation SynapseOverlayUpdatePayload
@end

@class SynapseOverlayController;

@interface SynapseOverlayView : NSView
@property(nonatomic, weak) SynapseOverlayController* controller;
@end

@interface SynapseOverlayController : NSObject
@property(nonatomic) uintptr_t controllerID;
@property(nonatomic, strong) NSThread* overlayThread;
@property(nonatomic, strong) NSCondition* startCondition;
@property(nonatomic) BOOL startFinished;
@property(nonatomic, copy) NSString* startupError;
@property(nonatomic, copy) NSString* activationError;
@property(nonatomic, copy) NSString* lastOperationError;
@property(nonatomic, strong) NSMutableArray<NSPanel*>* panels;
@property(nonatomic, strong) NSMutableArray<NSNumber*>* windowIDs;
@property(nonatomic, strong) NSTimer* redrawTimer;
@property(nonatomic, copy) NSString* runtimeSessionID;
@property(nonatomic, copy) NSString* labelText;
@property(nonatomic, copy) NSString* actionName;
@property(nonatomic, copy) NSString* scrollDirection;
@property(nonatomic) NSInteger currentScreenX;
@property(nonatomic) NSInteger currentScreenY;
@property(nonatomic) NSInteger previousScreenX;
@property(nonatomic) NSInteger previousScreenY;
@property(nonatomic) CFTimeInterval trailUntil;
@property(nonatomic) NSInteger pulseX;
@property(nonatomic) NSInteger pulseY;
@property(nonatomic) CFTimeInterval pulseUntil;
@property(nonatomic) NSInteger dragStartX;
@property(nonatomic) NSInteger dragStartY;
@property(nonatomic) NSInteger dragEndX;
@property(nonatomic) NSInteger dragEndY;
@property(nonatomic) CFTimeInterval dragUntil;
@property(nonatomic) NSInteger scrollX;
@property(nonatomic) NSInteger scrollY;
@property(nonatomic) CFTimeInterval scrollUntil;
@property(nonatomic) BOOL visible;
@property(nonatomic) EventHotKeyRef terminateHotKey;
@property(nonatomic) EventHotKeyRef disableHotKey;
@property(nonatomic) EventHandlerRef hotKeyHandler;
- (instancetype)initWithControllerID:(uintptr_t)controllerID;
- (void)startThreadAndWait;
- (NSArray<NSNumber*>*)copyWindowIDsForRuntimeSession:(NSString*)runtimeSessionID;
@end

static char* SynapseDuplicateCString(NSString* text) {
    if (text == nil) {
        return NULL;
    }
    const char* utf8 = [text UTF8String];
    if (utf8 == NULL) {
        return NULL;
    }
    size_t size = strlen(utf8) + 1;
    char* buffer = (char*)malloc(size);
    if (buffer == NULL) {
        return NULL;
    }
    memcpy(buffer, utf8, size);
    return buffer;
}

static NSPoint SynapseOverlayLocalPoint(NSWindow* window, NSInteger screenX, NSInteger screenY) {
    NSRect frame = [window frame];
    CGFloat localX = (CGFloat)screenX - frame.origin.x;
    CGFloat localY = frame.size.height - ((CGFloat)screenY - frame.origin.y);
    return NSMakePoint(localX, localY);
}

static void SynapseDrawTextCentered(NSString* text, NSRect rect, NSColor* color, CGFloat size, NSFontWeight weight) {
    if (text == nil || text.length == 0) {
        return;
    }
    NSFont* font = [NSFont systemFontOfSize:size weight:weight];
    NSDictionary* attrs = @{
        NSFontAttributeName: font,
        NSForegroundColorAttributeName: color,
        NSParagraphStyleAttributeName: ({
            NSMutableParagraphStyle* style = [[NSMutableParagraphStyle alloc] init];
            style.alignment = NSTextAlignmentCenter;
            style;
        }),
    };
    [text drawInRect:rect withAttributes:attrs];
}

@implementation SynapseOverlayView

- (BOOL)isFlipped {
    return YES;
}

- (BOOL)isOpaque {
    return NO;
}

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;

    SynapseOverlayController* controller = self.controller;
    if (controller == nil) {
        return;
    }

    NSString* label = nil;
    NSString* action = nil;
    NSString* direction = nil;
    NSInteger currentX = -1;
    NSInteger currentY = -1;
    NSInteger previousX = -1;
    NSInteger previousY = -1;
    NSInteger pulseX = -1;
    NSInteger pulseY = -1;
    NSInteger dragStartX = -1;
    NSInteger dragStartY = -1;
    NSInteger dragEndX = -1;
    NSInteger dragEndY = -1;
    NSInteger scrollX = -1;
    NSInteger scrollY = -1;
    CFTimeInterval trailUntil = 0;
    CFTimeInterval pulseUntil = 0;
    CFTimeInterval dragUntil = 0;
    CFTimeInterval scrollUntil = 0;
    BOOL visible = NO;

    @synchronized (controller) {
        label = controller.labelText ?: @"Remote desktop control is active";
        action = controller.actionName ?: @"";
        direction = controller.scrollDirection ?: @"";
        currentX = controller.currentScreenX;
        currentY = controller.currentScreenY;
        previousX = controller.previousScreenX;
        previousY = controller.previousScreenY;
        pulseX = controller.pulseX;
        pulseY = controller.pulseY;
        dragStartX = controller.dragStartX;
        dragStartY = controller.dragStartY;
        dragEndX = controller.dragEndX;
        dragEndY = controller.dragEndY;
        scrollX = controller.scrollX;
        scrollY = controller.scrollY;
        trailUntil = controller.trailUntil;
        pulseUntil = controller.pulseUntil;
        dragUntil = controller.dragUntil;
        scrollUntil = controller.scrollUntil;
        visible = controller.visible;
    }

    if (!visible) {
        return;
    }

    NSRect bounds = self.bounds;
    [[NSColor colorWithCalibratedWhite:0 alpha:0.88] setFill];
    NSRectFill(bounds);

    NSBezierPath* labelBox = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(28, 22, bounds.size.width - 56, 54) xRadius:12 yRadius:12];
    [[NSColor colorWithCalibratedWhite:0.10 alpha:0.94] setFill];
    [labelBox fill];
    SynapseDrawTextCentered(label, NSMakeRect(42, 30, bounds.size.width - 84, 36), [NSColor colorWithCalibratedWhite:0.97 alpha:1], 22, NSFontWeightSemibold);

    NSBezierPath* helpBox = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(36, bounds.size.height - 64, bounds.size.width - 72, 36) xRadius:10 yRadius:10];
    [[NSColor colorWithCalibratedWhite:0.08 alpha:0.94] setFill];
    [helpBox fill];
    SynapseDrawTextCentered(@"Ctrl+Alt+Shift+Esc stop session    Ctrl+Alt+Shift+Delete disable remote control until reboot", NSMakeRect(48, bounds.size.height - 58, bounds.size.width - 96, 24), [NSColor colorWithCalibratedWhite:0.86 alpha:1], 14, NSFontWeightRegular);

    CFTimeInterval now = CFAbsoluteTimeGetCurrent();
    if (trailUntil > now && previousX >= 0 && previousY >= 0 && currentX >= 0 && currentY >= 0) {
        NSPoint from = SynapseOverlayLocalPoint(self.window, previousX, previousY);
        NSPoint to = SynapseOverlayLocalPoint(self.window, currentX, currentY);
        [[NSColor colorWithCalibratedRed:0.48 green:0.74 blue:1 alpha:1] setStroke];
        NSBezierPath* path = [NSBezierPath bezierPath];
        [path setLineWidth:3];
        [path moveToPoint:from];
        [path lineToPoint:to];
        [path stroke];
    }

    if (dragUntil > now && dragStartX >= 0 && dragEndX >= 0) {
        NSPoint from = SynapseOverlayLocalPoint(self.window, dragStartX, dragStartY);
        NSPoint to = SynapseOverlayLocalPoint(self.window, dragEndX, dragEndY);
        [[NSColor colorWithCalibratedRed:1 green:0.83 blue:0.35 alpha:1] setStroke];
        NSBezierPath* path = [NSBezierPath bezierPath];
        [path setLineWidth:4];
        [path moveToPoint:from];
        [path lineToPoint:to];
        [path stroke];
    }

    if (currentX >= 0 && currentY >= 0) {
        NSPoint point = SynapseOverlayLocalPoint(self.window, currentX, currentY);
        NSBezierPath* cursor = [NSBezierPath bezierPath];
        [cursor moveToPoint:NSMakePoint(point.x, point.y)];
        [cursor lineToPoint:NSMakePoint(point.x, point.y + 24)];
        [cursor lineToPoint:NSMakePoint(point.x + 8, point.y + 18)];
        [cursor lineToPoint:NSMakePoint(point.x + 13, point.y + 31)];
        [cursor lineToPoint:NSMakePoint(point.x + 18, point.y + 29)];
        [cursor lineToPoint:NSMakePoint(point.x + 13, point.y + 16)];
        [cursor lineToPoint:NSMakePoint(point.x + 22, point.y + 16)];
        [cursor closePath];
        [[NSColor whiteColor] setFill];
        [cursor fill];
        [[NSColor colorWithCalibratedWhite:0.04 alpha:1] setStroke];
        [cursor setLineWidth:1.2];
        [cursor stroke];
    }

    if (pulseUntil > now && pulseX >= 0 && pulseY >= 0) {
        CGFloat progress = 1.0 - ((pulseUntil - now) / 0.45);
        CGFloat radius = 10.0 + progress * 28.0;
        NSPoint point = SynapseOverlayLocalPoint(self.window, pulseX, pulseY);
        NSRect circleRect = NSMakeRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
        NSBezierPath* circle = [NSBezierPath bezierPathWithOvalInRect:circleRect];
        [[NSColor colorWithCalibratedRed:0.31 green:0.72 blue:1 alpha:1] setStroke];
        [circle setLineWidth:3];
        [circle stroke];
    }

    if (scrollUntil > now && scrollX >= 0 && scrollY >= 0) {
        NSPoint point = SynapseOverlayLocalPoint(self.window, scrollX, scrollY);
        NSBezierPath* box = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(point.x - 40, point.y - 54, 80, 32) xRadius:8 yRadius:8];
        [[NSColor colorWithCalibratedWhite:0.12 alpha:0.96] setFill];
        [box fill];
        SynapseDrawTextCentered(direction.uppercaseString ?: @"", NSMakeRect(point.x - 34, point.y - 48, 68, 18), [NSColor colorWithCalibratedRed:1 green:0.89 blue:0.49 alpha:1], 14, NSFontWeightBold);
    }

    if (action.length > 0 && ![action isEqualToString:@"pointer_move"] && currentX >= 0 && currentY >= 0) {
        NSPoint point = SynapseOverlayLocalPoint(self.window, currentX, currentY);
        NSString* actionLabel = action;
        NSBezierPath* actionBox = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(point.x + 18, point.y - 10, 180, 32) xRadius:8 yRadius:8];
        [[NSColor colorWithCalibratedWhite:0.10 alpha:0.95] setFill];
        [actionBox fill];
        SynapseDrawTextCentered(actionLabel, NSMakeRect(point.x + 28, point.y - 4, 160, 18), [NSColor colorWithCalibratedWhite:0.92 alpha:1], 13, NSFontWeightMedium);
    }
}

@end

static OSStatus SynapseOverlayHotKeyHandler(EventHandlerCallRef nextHandler, EventRef event, void* userData) {
    (void)nextHandler;
    SynapseOverlayController* controller = (__bridge SynapseOverlayController*)userData;
    if (controller == nil) {
        return noErr;
    }

    EventHotKeyID hotKeyID = {0};
    GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(hotKeyID), NULL, &hotKeyID);
    if (hotKeyID.id == SynapseDarwinHotkeyTerminate) {
        synapseDarwinOverlayHotkeyCallback(controller.controllerID, SynapseDarwinHotkeyTerminate);
    } else if (hotKeyID.id == SynapseDarwinHotkeyDisable) {
        synapseDarwinOverlayHotkeyCallback(controller.controllerID, SynapseDarwinHotkeyDisable);
    }
    return noErr;
}

@implementation SynapseOverlayController

- (instancetype)initWithControllerID:(uintptr_t)controllerID {
    self = [super init];
    if (self != nil) {
        _controllerID = controllerID;
        _panels = [NSMutableArray array];
        _windowIDs = [NSMutableArray array];
        _startCondition = [[NSCondition alloc] init];
        _currentScreenX = -1;
        _currentScreenY = -1;
        _previousScreenX = -1;
        _previousScreenY = -1;
        _pulseX = -1;
        _pulseY = -1;
        _dragStartX = -1;
        _dragStartY = -1;
        _dragEndX = -1;
        _dragEndY = -1;
        _scrollX = -1;
        _scrollY = -1;
    }
    return self;
}

- (void)startThreadAndWait {
    [self.startCondition lock];
    self.overlayThread = [[NSThread alloc] initWithTarget:self selector:@selector(threadMain) object:nil];
    [self.overlayThread start];
    while (!self.startFinished) {
        [self.startCondition wait];
    }
    [self.startCondition unlock];
}

- (void)signalStarted {
    [self.startCondition lock];
    self.startFinished = YES;
    [self.startCondition signal];
    [self.startCondition unlock];
}

- (void)threadMain {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [self registerHotkeys];

        self.redrawTimer = [NSTimer timerWithTimeInterval:(1.0 / 60.0) target:self selector:@selector(onTick:) userInfo:nil repeats:YES];
        [[NSRunLoop currentRunLoop] addTimer:self.redrawTimer forMode:NSRunLoopCommonModes];
        [self signalStarted];

        while (![[NSThread currentThread] isCancelled]) {
            @autoreleasepool {
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
            }
        }

        [self.redrawTimer invalidate];
        self.redrawTimer = nil;
        [self unregisterHotkeys];
        [self destroyPanels];
    }
}

- (void)registerHotkeys {
    EventTypeSpec eventType = {kEventClassKeyboard, kEventHotKeyPressed};
    OSStatus status = InstallApplicationEventHandler(&SynapseOverlayHotKeyHandler, 1, &eventType, (__bridge void*)self, &_hotKeyHandler);
    if (status != noErr) {
        self.activationError = [NSString stringWithFormat:@"register overlay hotkey handler failed (%d)", (int)status];
        return;
    }

    EventHotKeyID terminateID = {'S', SynapseDarwinHotkeyTerminate};
    status = RegisterEventHotKey(53, controlKey | optionKey | shiftKey, terminateID, GetApplicationEventTarget(), 0, &_terminateHotKey);
    if (status != noErr) {
        self.activationError = [NSString stringWithFormat:@"register terminate hotkey failed (%d)", (int)status];
        return;
    }

    EventHotKeyID disableID = {'S', SynapseDarwinHotkeyDisable};
    status = RegisterEventHotKey(51, controlKey | optionKey | shiftKey, disableID, GetApplicationEventTarget(), 0, &_disableHotKey);
    if (status != noErr) {
        self.activationError = [NSString stringWithFormat:@"register disable hotkey failed (%d)", (int)status];
    }
}

- (void)unregisterHotkeys {
    if (self.terminateHotKey != NULL) {
        UnregisterEventHotKey(self.terminateHotKey);
        self.terminateHotKey = NULL;
    }
    if (self.disableHotKey != NULL) {
        UnregisterEventHotKey(self.disableHotKey);
        self.disableHotKey = NULL;
    }
    if (self.hotKeyHandler != NULL) {
        RemoveEventHandler(self.hotKeyHandler);
        self.hotKeyHandler = NULL;
    }
}

- (void)destroyPanels {
    for (NSPanel* panel in self.panels) {
        [panel orderOut:nil];
        [panel close];
    }
    [self.panels removeAllObjects];
    [self.windowIDs removeAllObjects];
}

- (void)rebuildPanels {
    [self destroyPanels];

    for (NSScreen* screen in [NSScreen screens]) {
        NSRect frame = [screen frame];
        NSPanel* panel = [[NSPanel alloc] initWithContentRect:frame styleMask:(NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel) backing:NSBackingStoreBuffered defer:NO screen:screen];
        panel.opaque = NO;
        panel.backgroundColor = [NSColor clearColor];
        panel.hasShadow = NO;
        panel.releasedWhenClosed = NO;
        panel.level = (NSInteger)CGShieldingWindowLevel();
        panel.ignoresMouseEvents = YES;
        panel.hidesOnDeactivate = NO;
        panel.sharingType = NSWindowSharingNone;
        panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
        [panel setExcludedFromWindowsMenu:YES];
        [panel setMovable:NO];

        SynapseOverlayView* view = [[SynapseOverlayView alloc] initWithFrame:NSMakeRect(0, 0, frame.size.width, frame.size.height)];
        view.controller = self;
        panel.contentView = view;
        [panel orderFrontRegardless];

        [self.panels addObject:panel];
        [self.windowIDs addObject:@((uint64_t)panel.windowNumber)];
    }
}

- (void)requestRedraw {
    for (NSPanel* panel in self.panels) {
        [panel.contentView setNeedsDisplay:YES];
    }
}

- (void)showOnThread:(NSString*)runtimeSessionID {
    self.lastOperationError = nil;
    if (self.activationError != nil) {
        self.lastOperationError = self.activationError;
        return;
    }
    if (@available(macOS 14.4, *)) {
    } else {
        self.lastOperationError = @"macOS 14.4 or newer is required for protected remote-control overlay";
        return;
    }

    @synchronized (self) {
        self.visible = YES;
        self.runtimeSessionID = runtimeSessionID ?: @"";
    }
    [self rebuildPanels];
    [self requestRedraw];
}

- (void)hideOnThread:(NSString*)runtimeSessionID {
    NSString* requested = runtimeSessionID ?: @"";
    @synchronized (self) {
        if (requested.length > 0 && ![requested isEqualToString:(self.runtimeSessionID ?: @"")]) {
            return;
        }
        self.visible = NO;
        self.runtimeSessionID = @"";
        self.labelText = @"";
        self.actionName = @"";
    }
    for (NSPanel* panel in self.panels) {
        [panel orderOut:nil];
    }
    [self destroyPanels];
}

- (void)applyUpdateOnThread:(SynapseOverlayUpdatePayload*)payload {
    NSString* requested = payload.runtimeSessionID ?: @"";
    @synchronized (self) {
        if (!self.visible || ![requested isEqualToString:(self.runtimeSessionID ?: @"")]) {
            return;
        }

        CFTimeInterval now = CFAbsoluteTimeGetCurrent();
        self.labelText = payload.labelText ?: @"";
        self.actionName = payload.actionName ?: @"";
        if (payload.screenX >= 0 && payload.screenY >= 0) {
            if (self.currentScreenX >= 0 && self.currentScreenY >= 0) {
                self.previousScreenX = self.currentScreenX;
                self.previousScreenY = self.currentScreenY;
                self.trailUntil = now + 0.45;
            }
            self.currentScreenX = payload.screenX;
            self.currentScreenY = payload.screenY;
        }

        if ([payload.actionName isEqualToString:@"click"]) {
            self.pulseX = payload.screenX;
            self.pulseY = payload.screenY;
            self.pulseUntil = now + 0.45;
        } else if ([payload.actionName isEqualToString:@"drag"]) {
            self.dragStartX = payload.startScreenX;
            self.dragStartY = payload.startScreenY;
            self.dragEndX = payload.endScreenX;
            self.dragEndY = payload.endScreenY;
            self.dragUntil = now + 0.70;
        } else if ([payload.actionName isEqualToString:@"scroll"]) {
            self.scrollX = payload.screenX;
            self.scrollY = payload.screenY;
            self.scrollDirection = payload.direction ?: @"";
            self.scrollUntil = now + 0.55;
        }
    }
    [self requestRedraw];
}

- (void)onTick:(NSTimer*)timer {
    (void)timer;
    BOOL visible = NO;
    @synchronized (self) {
        visible = self.visible;
    }
    if (visible) {
        [self requestRedraw];
    }
}

- (void)stopOnThread:(id)unused {
    (void)unused;
    [[NSThread currentThread] cancel];
    CFRunLoopStop(CFRunLoopGetCurrent());
}

- (NSArray<NSNumber*>*)copyWindowIDsForRuntimeSession:(NSString*)runtimeSessionID {
    NSString* requested = runtimeSessionID ?: @"";
    @synchronized (self) {
        if (!self.visible || ![requested isEqualToString:(self.runtimeSessionID ?: @"")]) {
            return @[];
        }
        return [self.windowIDs copy];
    }
}

@end

static void* synapse_overlay_create(uintptr_t controllerID, char** errorOut) {
    @autoreleasepool {
        SynapseOverlayController* controller = [[SynapseOverlayController alloc] initWithControllerID:controllerID];
        [controller startThreadAndWait];
        if (controller.startupError != nil) {
            if (errorOut != NULL) {
                *errorOut = SynapseDuplicateCString(controller.startupError);
            }
            return NULL;
        }
        return (__bridge_retained void*)controller;
    }
}

static char* synapse_overlay_show(void* handle, const char* runtimeSessionID) {
    @autoreleasepool {
        if (handle == NULL) {
            return SynapseDuplicateCString(@"overlay controller is not running");
        }
        SynapseOverlayController* controller = (__bridge SynapseOverlayController*)handle;
        NSString* session = runtimeSessionID != NULL ? [NSString stringWithUTF8String:runtimeSessionID] : @"";
        [controller performSelector:@selector(showOnThread:) onThread:controller.overlayThread withObject:session waitUntilDone:YES];
        return SynapseDuplicateCString(controller.lastOperationError);
    }
}

static void synapse_overlay_hide(void* handle, const char* runtimeSessionID) {
    @autoreleasepool {
        if (handle == NULL) {
            return;
        }
        SynapseOverlayController* controller = (__bridge SynapseOverlayController*)handle;
        NSString* session = runtimeSessionID != NULL ? [NSString stringWithUTF8String:runtimeSessionID] : @"";
        [controller performSelector:@selector(hideOnThread:) onThread:controller.overlayThread withObject:session waitUntilDone:YES];
    }
}

static void synapse_overlay_update(void* handle,
                                   const char* runtimeSessionID,
                                   const char* actionName,
                                   const char* labelText,
                                   int screenX,
                                   int screenY,
                                   int startScreenX,
                                   int startScreenY,
                                   int endScreenX,
                                   int endScreenY,
                                   const char* direction) {
    @autoreleasepool {
        if (handle == NULL) {
            return;
        }
        SynapseOverlayController* controller = (__bridge SynapseOverlayController*)handle;
        SynapseOverlayUpdatePayload* payload = [[SynapseOverlayUpdatePayload alloc] init];
        payload.runtimeSessionID = runtimeSessionID != NULL ? [NSString stringWithUTF8String:runtimeSessionID] : @"";
        payload.actionName = actionName != NULL ? [NSString stringWithUTF8String:actionName] : @"";
        payload.labelText = labelText != NULL ? [NSString stringWithUTF8String:labelText] : @"";
        payload.direction = direction != NULL ? [NSString stringWithUTF8String:direction] : @"";
        payload.screenX = screenX;
        payload.screenY = screenY;
        payload.startScreenX = startScreenX;
        payload.startScreenY = startScreenY;
        payload.endScreenX = endScreenX;
        payload.endScreenY = endScreenY;
        [controller performSelector:@selector(applyUpdateOnThread:) onThread:controller.overlayThread withObject:payload waitUntilDone:NO];
    }
}

static void synapse_overlay_destroy(void* handle) {
    @autoreleasepool {
        if (handle == NULL) {
            return;
        }
        SynapseOverlayController* controller = (__bridge SynapseOverlayController*)handle;
        [controller performSelector:@selector(stopOnThread:) onThread:controller.overlayThread withObject:nil waitUntilDone:YES];
        (void)CFBridgingRelease(handle);
    }
}

static uint64_t* synapse_overlay_copy_window_ids(void* handle, const char* runtimeSessionID, size_t* countOut) {
    @autoreleasepool {
        if (countOut != NULL) {
            *countOut = 0;
        }
        if (handle == NULL) {
            return NULL;
        }
        SynapseOverlayController* controller = (__bridge SynapseOverlayController*)handle;
        NSString* session = runtimeSessionID != NULL ? [NSString stringWithUTF8String:runtimeSessionID] : @"";
        NSArray<NSNumber*>* ids = [controller copyWindowIDsForRuntimeSession:session];
        if (ids.count == 0) {
            return NULL;
        }
        uint64_t* buffer = (uint64_t*)calloc(ids.count, sizeof(uint64_t));
        if (buffer == NULL) {
            return NULL;
        }
        for (NSUInteger i = 0; i < ids.count; i++) {
            buffer[i] = ids[i].unsignedLongLongValue;
        }
        if (countOut != NULL) {
            *countOut = ids.count;
        }
        return buffer;
    }
}

static void synapse_overlay_free_string(char* text) {
    free(text);
}

static void synapse_overlay_free_window_ids(uint64_t* ids) {
    free(ids);
}
*/
import "C"

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"
)

var (
	darwinOverlayControllers  sync.Map
	darwinOverlayControllerID atomic.Uint64
)

type darwinOverlayController struct {
	hotkeyHandler func(overlayHotkeyAction)

	startOnce sync.Once
	closeOnce sync.Once

	startErr error
	handle   unsafe.Pointer
	id       uint64
}

func newStubOverlayController(handler func(overlayHotkeyAction)) overlayController {
	return &darwinOverlayController{
		hotkeyHandler: handler,
		id:            darwinOverlayControllerID.Add(1),
	}
}

func (d *darwinOverlayController) Start() error {
	d.startOnce.Do(func() {
		var errText *C.char
		handle := C.synapse_overlay_create(C.uintptr_t(d.id), &errText)
		if errText != nil {
			defer C.synapse_overlay_free_string(errText)
			d.startErr = errors.New(C.GoString(errText))
			return
		}
		if handle == nil {
			d.startErr = errors.New("failed to start macOS overlay controller")
			return
		}
		d.handle = handle
		darwinOverlayControllers.Store(d.id, d)
	})
	return d.startErr
}

func (d *darwinOverlayController) Close() error {
	if err := d.Start(); err != nil {
		return err
	}

	d.closeOnce.Do(func() {
		if d.handle != nil {
			C.synapse_overlay_destroy(d.handle)
			d.handle = nil
		}
		darwinOverlayControllers.Delete(d.id)
	})
	return nil
}

func (d *darwinOverlayController) Show(runtimeSessionID string) error {
	if err := d.Start(); err != nil {
		return err
	}
	session := C.CString(strings.TrimSpace(runtimeSessionID))
	defer C.free(unsafe.Pointer(session))

	errText := C.synapse_overlay_show(d.handle, session)
	if errText != nil {
		defer C.synapse_overlay_free_string(errText)
		return errors.New(C.GoString(errText))
	}
	return nil
}

func (d *darwinOverlayController) Hide(runtimeSessionID string) {
	if d.Start() != nil || d.handle == nil {
		return
	}
	session := C.CString(strings.TrimSpace(runtimeSessionID))
	defer C.free(unsafe.Pointer(session))
	C.synapse_overlay_hide(d.handle, session)
}

func (d *darwinOverlayController) Update(state actionHUDState) {
	if d.Start() != nil || d.handle == nil {
		return
	}

	runtimeSessionID := C.CString(strings.TrimSpace(state.RuntimeSessionID))
	action := C.CString(strings.TrimSpace(state.Action))
	label := C.CString(strings.TrimSpace(state.Label))
	direction := C.CString(strings.TrimSpace(state.Direction))
	defer C.free(unsafe.Pointer(runtimeSessionID))
	defer C.free(unsafe.Pointer(action))
	defer C.free(unsafe.Pointer(label))
	defer C.free(unsafe.Pointer(direction))

	C.synapse_overlay_update(
		d.handle,
		runtimeSessionID,
		action,
		label,
		C.int(state.ScreenX),
		C.int(state.ScreenY),
		C.int(state.StartScreenX),
		C.int(state.StartScreenY),
		C.int(state.EndScreenX),
		C.int(state.EndScreenY),
		direction,
	)
}

func (d *darwinOverlayController) CaptureInfo(runtimeSessionID string) overlayCaptureInfo {
	if d.Start() != nil || d.handle == nil {
		return overlayCaptureInfo{}
	}

	session := C.CString(strings.TrimSpace(runtimeSessionID))
	defer C.free(unsafe.Pointer(session))

	var count C.size_t
	ids := C.synapse_overlay_copy_window_ids(d.handle, session, &count)
	if ids == nil || count == 0 {
		return overlayCaptureInfo{}
	}
	defer C.synapse_overlay_free_window_ids(ids)

	windowIDs := make([]uint64, int(count))
	raw := unsafe.Slice((*C.uint64_t)(ids), int(count))
	for i := range raw {
		windowIDs[i] = uint64(raw[i])
	}
	return overlayCaptureInfo{ExcludedWindowIDs: windowIDs}
}

//export synapseDarwinOverlayHotkeyCallback
func synapseDarwinOverlayHotkeyCallback(controllerID C.uintptr_t, action C.int) {
	raw, ok := darwinOverlayControllers.Load(uint64(controllerID))
	if !ok {
		return
	}
	controller, ok := raw.(*darwinOverlayController)
	if !ok || controller == nil || controller.hotkeyHandler == nil {
		return
	}

	switch int(action) {
	case int(C.SynapseDarwinHotkeyTerminate):
		go controller.hotkeyHandler(overlayHotkeyTerminate)
	case int(C.SynapseDarwinHotkeyDisable):
		go controller.hotkeyHandler(overlayHotkeyDisableBoot)
	}
}
