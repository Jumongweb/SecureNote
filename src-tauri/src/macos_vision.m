#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <UserNotifications/UserNotifications.h>
#include <stdlib.h>
#include <string.h>

char *snv_recognize_text(const unsigned char *bytes, size_t length) {
  @autoreleasepool {
    if (@available(macOS 10.15, *)) {
    NSData *data = [NSData dataWithBytes:bytes length:length];
    NSImage *image = [[NSImage alloc] initWithData:data];
    if (image == nil) return strdup("");

    CGRect rect = CGRectMake(0, 0, image.size.width, image.size.height);
    CGImageRef cgImage = [image CGImageForProposedRect:&rect context:nil hints:nil];
    if (cgImage == nil) return strdup("");

    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = YES;

    NSError *error = nil;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];
    if (![handler performRequests:@[request] error:&error]) return strdup("");

    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results) {
      VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
      if (candidate.string.length > 0) [lines addObject:candidate.string];
    }
    NSString *result = [lines componentsJoinedByString:@"\n"];
    return strdup(result.UTF8String ?: "");
    }
    return strdup("");
  }
}

void snv_free_string(char *value) {
  free(value);
}

void snv_clear_reminders(void) {
  @autoreleasepool {
    if (@available(macOS 10.14, *)) {
      [[UNUserNotificationCenter currentNotificationCenter] removeAllPendingNotificationRequests];
    }
  }
}

void snv_schedule_reminder(const char *identifier, double epoch_seconds) {
  @autoreleasepool {
    if (@available(macOS 10.14, *)) {
      NSString *requestId = [NSString stringWithUTF8String:identifier ?: ""];
      if (requestId.length == 0) return;
      NSTimeInterval interval = epoch_seconds - [[NSDate date] timeIntervalSince1970];
      if (interval <= 0) return;
      UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
      [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                            completionHandler:^(BOOL granted, NSError *error) {
        if (!granted || error != nil) return;
        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = @"Secure Note Vault";
        content.body = @"A private task is due. Unlock your vault to review it.";
        content.sound = [UNNotificationSound defaultSound];
        UNTimeIntervalNotificationTrigger *trigger = [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:MAX(interval, 1.0) repeats:NO];
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:requestId content:content trigger:trigger];
        [center addNotificationRequest:request withCompletionHandler:nil];
      }];
    }
  }
}
