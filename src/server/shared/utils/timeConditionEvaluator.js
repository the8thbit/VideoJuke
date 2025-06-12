class TimeConditionEvaluator {
    constructor(logger) {
        this.logger = logger;
    }
    
    /**
     * Evaluates if current time matches the given conditions
     * @param {Object} conditions - Time conditions object
     * @returns {boolean} - True if current time matches all conditions
     */
    evaluate(conditions) {
        if (!conditions || typeof conditions !== 'object') {
            return false;
        }
        
        const now = new Date();
        
        try {
            // Check each condition type
            if (conditions.dayOfWeek !== undefined) {
                if (!this.checkDayOfWeek(now, conditions.dayOfWeek)) return false;
            }
            
            if (conditions.hourRange !== undefined) {
                if (!this.checkHourRange(now, conditions.hourRange)) return false;
            }
            
            if (conditions.hour !== undefined) {
                if (!this.checkHour(now, conditions.hour)) return false;
            }
            
            if (conditions.minute !== undefined) {
                if (!this.checkMinute(now, conditions.minute)) return false;
            }
            
            if (conditions.minuteParity !== undefined) {
                if (!this.checkMinuteParity(now, conditions.minuteParity)) return false;
            }
            
            if (conditions.dayOfMonth !== undefined) {
                if (!this.checkDayOfMonth(now, conditions.dayOfMonth)) return false;
            }
            
            if (conditions.month !== undefined) {
                if (!this.checkMonth(now, conditions.month)) return false;
            }
            
            if (conditions.year !== undefined) {
                if (!this.checkYear(now, conditions.year)) return false;
            }
            
            if (conditions.dateRange !== undefined) {
                if (!this.checkDateRange(now, conditions.dateRange)) return false;
            }
            
            return true;
            
        } catch (error) {
            this.logger.error('Error evaluating time conditions', error);
            return false;
        }
    }
    
    checkDayOfWeek(date, allowedDays) {
        const dayOfWeek = date.getDay(); // 0=Sunday, 1=Monday, etc.
        return Array.isArray(allowedDays) ? allowedDays.includes(dayOfWeek) : allowedDays === dayOfWeek;
    }
    
    checkHourRange(date, range) {
        if (!Array.isArray(range) || range.length !== 2) return false;
        const hour = date.getHours();
        const [start, end] = range;
        
        if (start <= end) {
            return hour >= start && hour < end;
        } else {
            // Handle overnight ranges (e.g., 22-6 for 10PM to 6AM)
            return hour >= start || hour < end;
        }
    }
    
    checkHour(date, allowedHours) {
        const hour = date.getHours();
        return Array.isArray(allowedHours) ? allowedHours.includes(hour) : allowedHours === hour;
    }
    
    checkMinute(date, allowedMinutes) {
        const minute = date.getMinutes();
        return Array.isArray(allowedMinutes) ? allowedMinutes.includes(minute) : allowedMinutes === minute;
    }
    
    checkMinuteParity(date, parity) {
        const minute = date.getMinutes();
        if (parity === 'even') return minute % 2 === 0;
        if (parity === 'odd') return minute % 2 === 1;
        return false;
    }
    
    checkDayOfMonth(date, allowedDays) {
        const day = date.getDate();
        return Array.isArray(allowedDays) ? allowedDays.includes(day) : allowedDays === day;
    }
    
    checkMonth(date, allowedMonths) {
        const month = date.getMonth() + 1; // 1-12 instead of 0-11
        return Array.isArray(allowedMonths) ? allowedMonths.includes(month) : allowedMonths === month;
    }
    
    checkYear(date, allowedYears) {
        const year = date.getFullYear();
        return Array.isArray(allowedYears) ? allowedYears.includes(year) : allowedYears === year;
    }
    
    checkDateRange(date, range) {
        if (!Array.isArray(range) || range.length !== 2) return false;
        const [startDate, endDate] = range.map(d => new Date(d));
        return date >= startDate && date <= endDate;
    }
    
    /**
     * Get debug info about what conditions would match for current time
     */
    getDebugInfo() {
        const now = new Date();
        return {
            currentTime: now.toISOString(),
            dayOfWeek: now.getDay(),
            hour: now.getHours(),
            minute: now.getMinutes(),
            dayOfMonth: now.getDate(),
            month: now.getMonth() + 1,
            year: now.getFullYear(),
            minuteParity: now.getMinutes() % 2 === 0 ? 'even' : 'odd'
        };
    }
}

module.exports = TimeConditionEvaluator;